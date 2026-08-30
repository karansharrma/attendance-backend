import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PunchType, ReviewStatus } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  SyncAttendanceDto,
  SyncAttendanceRecordDto,
  SyncRecordResult,
  SyncResponse,
} from './dto/sync-attendance.dto';

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Idempotent bulk sync.
   *
   * Three properties the mobile client depends on:
   *
   *  1. **Upsert on the client-generated id.** The sync worker retries whenever the network
   *     drops mid-request, so the same batch arrives more than once as a matter of routine.
   *     A blind insert would duplicate every record that was written but whose response was
   *     lost, which is precisely the case retries exist to handle.
   *  2. **An admin's review decision is never clobbered.** A record the device re-pushes
   *     months later must not reset an APPROVED flag back to PENDING, so review fields are
   *     excluded from the update branch.
   *  3. **Per-record outcomes.** The worker marks records individually, and needs to know
   *     which ones are permanently unacceptable rather than retryable.
   */
  async sync(user: AuthenticatedUser, dto: SyncAttendanceDto): Promise<SyncResponse> {
    const foreign = dto.records.filter((r) => r.employeeId && r.employeeId !== user.sub);
    if (foreign.length > 0) {
      // A whole-batch rejection, not a per-record one: a device attempting to file
      // attendance for another employee is a security event, not a data-quality problem.
      this.logger.error(
        `Employee ${user.sub} attempted to sync ${foreign.length} record(s) belonging to ` +
          `other employees: ${foreign.map((r) => r.employeeId).join(', ')}`,
      );
      throw new ForbiddenException('You may only sync attendance records for yourself');
    }

    // A client bug can repeat an id inside one batch. Last write wins, so the request stays
    // idempotent with itself as well as with earlier requests.
    const deduped = new Map<string, SyncAttendanceRecordDto>();
    for (const record of dto.records) deduped.set(record.id, record);

    const knownSiteIds = await this.resolveKnownSites(Array.from(deduped.values()));

    const results: SyncRecordResult[] = [];
    let accepted = 0;
    let rejected = 0;

    for (const record of deduped.values()) {
      try {
        const result = await this.upsertOne(user.sub, record, knownSiteIds);
        if (result.outcome === 'created') {
          // A push failure must never turn a successfully stored attendance event into a retry.
          try {
            await this.notifications.notifyAdminsOfAttendance(user.sub, record);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'unknown notification error';
            this.logger.error(`Notification failed for attendance record ${record.id}: ${message}`);
          }
        }
        results.push(result);
        accepted += 1;
      } catch (error) {
        rejected += 1;
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`Sync rejected record ${record.id} for ${user.sub}: ${message}`);
        results.push({ id: record.id, outcome: 'rejected', message });
      }
    }

    this.logger.log(
      `Sync from ${user.sub}: ${accepted} accepted, ${rejected} rejected ` +
        `(${dto.records.length} submitted, ${deduped.size} unique)`,
    );

    return { accepted, rejected, results, serverTime: new Date().toISOString() };
  }

  private async upsertOne(
    employeeId: string,
    record: SyncAttendanceRecordDto,
    knownSiteIds: Set<string>,
  ): Promise<SyncRecordResult> {
    const existing = await this.prisma.attendanceRecord.findUnique({
      where: { id: record.id },
      select: { id: true, employeeId: true, reviewStatus: true },
    });

    if (existing && existing.employeeId !== employeeId) {
      // The id is a client-generated UUID; a collision across employees means either a
      // broken RNG or a deliberate attempt to overwrite somebody else's record.
      throw new Error('That record id already belongs to a different employee');
    }

    const deviceOwnedFields = {
      timestamp: new Date(record.timestamp),
      latitude: record.latitude,
      longitude: record.longitude,
      matchedSiteId: record.matchedSiteId ?? null,
      faceMatchConfidence: record.faceMatchConfidence,
      status: record.status,
      isMockLocation: record.isMockLocation,
      punchType: record.punchType,
    };

    await this.prisma.attendanceRecord.upsert({
      where: { id: record.id },
      create: {
        id: record.id,
        employeeId,
        ...deviceOwnedFields,
        reviewStatus: ReviewStatus.PENDING,
      },
      // reviewStatus, reviewedByAdminId, reviewedAt and reviewNote are deliberately absent:
      // they belong to the admin, not the device.
      update: deviceOwnedFields,
    });

    // Handle punch-in/punch-out pairing and shift calculation
    if (record.punchType === PunchType.OUT && !existing) {
      await this.pairWithPunchIn(employeeId, record.id, new Date(record.timestamp));
    }

    const warnings: string[] = [];
    if (record.matchedSiteId && !knownSiteIds.has(record.matchedSiteId)) {
      // Stored anyway. matchedSiteId is not a foreign key precisely so a record survives the
      // deletion of the site it was tagged to.
      warnings.push(`matchedSiteId ${record.matchedSiteId} does not match any current site`);
    }
    if (record.isMockLocation) {
      this.logger.warn(
        `Record ${record.id} from ${employeeId} was flagged as a mock location by the device`,
      );
      warnings.push('record was flagged as originating from a mock location provider');
    }

    return {
      id: record.id,
      outcome: existing ? 'updated' : 'created',
      ...(warnings.length > 0 ? { message: warnings.join('; ') } : {}),
    };
  }

  /**
   * Pair a punch-out with the most recent unpaired punch-in and calculate shift duration.
   */
  private async pairWithPunchIn(
    employeeId: string,
    punchOutId: string,
    punchOutTime: Date,
  ): Promise<void> {
    // Find the most recent unpaired punch-in for this employee
    const recentPunchIn = await this.prisma.attendanceRecord.findFirst({
      where: {
        employeeId,
        punchType: PunchType.IN,
        pairedPunchId: null,
        timestamp: { lt: punchOutTime },
      },
      orderBy: { timestamp: 'desc' },
    });

    if (recentPunchIn) {
      // Calculate shift duration in minutes
      const durationMs = punchOutTime.getTime() - recentPunchIn.timestamp.getTime();
      const durationMinutes = Math.floor(durationMs / (1000 * 60));

      // Update both records to establish the pairing
      await this.prisma.attendanceRecord.updateMany({
        where: { id: recentPunchIn.id },
        data: { pairedPunchId: punchOutId },
      });

      await this.prisma.attendanceRecord.update({
        where: { id: punchOutId },
        data: {
          pairedPunchId: recentPunchIn.id,
          shiftDurationMinutes: durationMinutes,
        },
      });

      this.logger.log(
        `Paired punch-in ${recentPunchIn.id} with punch-out ${punchOutId} for employee ${employeeId}. Shift duration: ${durationMinutes} minutes`,
      );
    } else {
      this.logger.warn(
        `No unpaired punch-in found for punch-out ${punchOutId} for employee ${employeeId}`,
      );
    }
  }

  /** One query for the whole batch rather than one per record. */
  private async resolveKnownSites(records: SyncAttendanceRecordDto[]): Promise<Set<string>> {
    const ids = Array.from(
      new Set(records.map((r) => r.matchedSiteId).filter((id): id is string => Boolean(id))),
    );
    if (ids.length === 0) return new Set();

    const sites = await this.prisma.site.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    return new Set(sites.map((site) => site.id));
  }
}
