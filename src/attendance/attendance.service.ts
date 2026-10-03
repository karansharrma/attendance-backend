import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { AttendanceStatus, Prisma, PunchType, ReviewStatus } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import { PaginatedResponse, paginate } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MyAttendanceQueryDto } from './dto/my-attendance-query.dto';
import {
  SyncAttendanceDto,
  SyncAttendanceRecordDto,
  SyncRecordResult,
  SyncResponse,
} from './dto/sync-attendance.dto';

/** One row of GET /attendance/me. Mirrors the device's Room entity plus server-owned fields. */
export interface MyAttendanceRow {
  id: string;
  employeeId: string;
  timestamp: Date;
  latitude: number | null;
  longitude: number | null;
  matchedSiteId: string | null;
  /** Null when there is no matched site, or the site has since been deleted. */
  matchedSiteName: string | null;
  faceMatchConfidence: number;
  status: AttendanceStatus;
  isMockLocation: boolean;
  punchType: PunchType;
  pairedPunchId: string | null;
  shiftDurationMinutes: number | null;
  reviewStatus: ReviewStatus;
  reviewedAt: Date | null;
  reviewNote: string | null;
  createdAt: Date;
}

/**
 * Whether the syncing employee is bound to geofences. Only resolved when a batch contains a
 * record without coordinates, since that is the only case the server second-guesses.
 */
interface GeofenceContext {
  restricted: boolean;
}

interface UpsertOutcome {
  result: SyncRecordResult;
  /** The punch type actually stored, after defaulting. */
  punchType: PunchType;
}

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
   *
   * Backward compatibility: `punchType` is optional (older app builds never send it) and
   * defaults to IN on create; latitude/longitude may be null when the device had no GPS fix.
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
    const records = Array.from(deduped.values());

    const knownSiteIds = await this.resolveKnownSites(records);
    const geofence = records.some((r) => !hasCoordinates(r))
      ? await this.resolveGeofenceContext(user.sub)
      : null;

    const results: SyncRecordResult[] = [];
    let accepted = 0;
    let rejected = 0;

    for (const record of records) {
      try {
        const { result, punchType } = await this.upsertOne(
          user.sub,
          record,
          knownSiteIds,
          geofence,
        );
        if (result.outcome === 'created') {
          // A push failure must never turn a successfully stored attendance event into a retry.
          try {
            await this.notifications.notifyAdminsOfAttendance(user.sub, { ...record, punchType });
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

  /**
   * The caller's own records, newest first, in the standard paginated shape. Always scoped to
   * the token's employee id -- there is deliberately no employeeId parameter.
   */
  async findMine(
    user: AuthenticatedUser,
    query: MyAttendanceQueryDto,
  ): Promise<PaginatedResponse<MyAttendanceRow>> {
    const timestamp: Prisma.DateTimeFilter = {};
    if (query.from) timestamp.gte = new Date(query.from);
    if (query.to) timestamp.lt = new Date(query.to);
    if (timestamp.gte && timestamp.lt && timestamp.gte >= timestamp.lt) {
      throw new BadRequestException('from must be earlier than to');
    }

    const where: Prisma.AttendanceRecordWhereInput = {
      employeeId: user.sub,
      ...(timestamp.gte || timestamp.lt ? { timestamp } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.attendanceRecord.findMany({
        where,
        // id as a tie-breaker keeps page boundaries stable when two punches share a timestamp.
        orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.attendanceRecord.count({ where }),
    ]);

    const siteNames = await this.resolveSiteNames(rows.map((row) => row.matchedSiteId));

    const data: MyAttendanceRow[] = rows.map((row) => ({
      id: row.id,
      employeeId: row.employeeId,
      timestamp: row.timestamp,
      latitude: row.latitude,
      longitude: row.longitude,
      matchedSiteId: row.matchedSiteId,
      matchedSiteName: row.matchedSiteId ? (siteNames.get(row.matchedSiteId) ?? null) : null,
      faceMatchConfidence: row.faceMatchConfidence,
      status: row.status,
      isMockLocation: row.isMockLocation,
      punchType: row.punchType,
      pairedPunchId: row.pairedPunchId,
      shiftDurationMinutes: row.shiftDurationMinutes,
      reviewStatus: row.reviewStatus,
      reviewedAt: row.reviewedAt,
      reviewNote: row.reviewNote,
      createdAt: row.createdAt,
    }));

    return paginate(data, total, query.page, query.limit);
  }

  private async upsertOne(
    employeeId: string,
    record: SyncAttendanceRecordDto,
    knownSiteIds: Set<string>,
    geofence: GeofenceContext | null,
  ): Promise<UpsertOutcome> {
    const existing = await this.prisma.attendanceRecord.findUnique({
      where: { id: record.id },
      select: { id: true, employeeId: true, punchType: true, pairedPunchId: true },
    });

    if (existing && existing.employeeId !== employeeId) {
      // The id is a client-generated UUID; a collision across employees means either a
      // broken RNG or a deliberate attempt to overwrite somebody else's record.
      throw new Error('That record id already belongs to a different employee');
    }

    const latPresent = record.latitude !== null && record.latitude !== undefined;
    const lngPresent = record.longitude !== null && record.longitude !== undefined;
    if (latPresent !== lngPresent) {
      throw new Error('latitude and longitude must both be present or both be null');
    }

    const warnings: string[] = [];
    const status = this.effectiveStatus(record, geofence, warnings);

    // Older app builds never send punchType. On create that means IN (they could only punch
    // in); on a re-sync it means "unchanged", so a legacy replay cannot flip a stored OUT.
    const punchType = record.punchType ?? existing?.punchType ?? PunchType.IN;

    const deviceOwnedFields = {
      timestamp: new Date(record.timestamp),
      latitude: latPresent ? (record.latitude as number) : null,
      longitude: lngPresent ? (record.longitude as number) : null,
      matchedSiteId: record.matchedSiteId ?? null,
      faceMatchConfidence: record.faceMatchConfidence,
      status,
      isMockLocation: record.isMockLocation,
      punchType,
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
      // they belong to the admin, not the device. pairedPunchId and shiftDurationMinutes are
      // absent too: they are server-computed, and a replay must not reset them.
      update: deviceOwnedFields,
    });

    // Pair an OUT that is not yet paired. Keyed on the stored pairing rather than on "is this
    // a new record", so a sync whose pairing step failed after the upsert completes the
    // pairing on retry, while a replay of an already-paired OUT is a no-op.
    if (punchType === PunchType.OUT && !existing?.pairedPunchId) {
      await this.pairWithPunchIn(employeeId, record.id, new Date(record.timestamp));
    }

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
      punchType,
      result: {
        id: record.id,
        outcome: existing ? 'updated' : 'created',
        ...(warnings.length > 0 ? { message: warnings.join('; ') } : {}),
      },
    };
  }

  /**
   * The server otherwise trusts the device's geofence verdict, but a record without
   * coordinates cannot have been checked against any geofence. Such a record is stored (it
   * is still a face-verified attendance event, and rejecting it would lose it for good) but
   * never as VERIFIED, and never as UNRESTRICTED for an employee who is bound to sites; it
   * is downgraded to FLAGGED_OUTSIDE_GEOFENCE so an admin reviews it.
   *
   * Deterministic in its inputs, so a replay stores the same status as the first sync.
   */
  private effectiveStatus(
    record: SyncAttendanceRecordDto,
    geofence: GeofenceContext | null,
    warnings: string[],
  ): AttendanceStatus {
    if (hasCoordinates(record)) return record.status;

    const downgrade =
      record.status === AttendanceStatus.VERIFIED ||
      (record.status === AttendanceStatus.UNRESTRICTED && (geofence?.restricted ?? true));

    if (!downgrade) return record.status;

    warnings.push(
      `status ${record.status} cannot be confirmed without coordinates; ` +
        `stored as ${AttendanceStatus.FLAGGED_OUTSIDE_GEOFENCE}`,
    );
    return AttendanceStatus.FLAGGED_OUTSIDE_GEOFENCE;
  }

  /**
   * Mirrors the device's rule: an employee with `isUnrestricted`, or with no assigned sites,
   * may punch from anywhere. Anyone else is restricted. A missing employee is treated as
   * restricted (fail closed).
   */
  private async resolveGeofenceContext(employeeId: string): Promise<GeofenceContext> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { isUnrestricted: true, _count: { select: { sites: true } } },
    });
    if (!employee) return { restricted: true };
    return { restricted: !employee.isUnrestricted && employee._count.sites > 0 };
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

    if (!recentPunchIn) {
      this.logger.warn(
        `No unpaired punch-in found for punch-out ${punchOutId} for employee ${employeeId}`,
      );
      return;
    }

    // Claim the punch-in only if it is still unpaired, so two concurrent syncs of different
    // punch-outs cannot both pair with the same punch-in.
    const claimed = await this.prisma.attendanceRecord.updateMany({
      where: { id: recentPunchIn.id, pairedPunchId: null },
      data: { pairedPunchId: punchOutId },
    });
    if (claimed.count === 0) {
      this.logger.warn(
        `Punch-in ${recentPunchIn.id} was paired concurrently; punch-out ${punchOutId} left unpaired`,
      );
      return;
    }

    const durationMs = punchOutTime.getTime() - recentPunchIn.timestamp.getTime();
    const durationMinutes = Math.floor(durationMs / (1000 * 60));

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
  }

  /** One query for the whole batch rather than one per record. */
  private async resolveKnownSites(records: SyncAttendanceRecordDto[]): Promise<Set<string>> {
    const names = await this.resolveSiteNames(records.map((r) => r.matchedSiteId ?? null));
    return new Set(names.keys());
  }

  private async resolveSiteNames(siteIds: (string | null)[]): Promise<Map<string, string>> {
    const ids = Array.from(new Set(siteIds.filter((id): id is string => Boolean(id))));
    if (ids.length === 0) return new Map();

    const sites = await this.prisma.site.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(sites.map((site) => [site.id, site.name]));
  }
}

function hasCoordinates(record: SyncAttendanceRecordDto): boolean {
  return (
    record.latitude !== null &&
    record.latitude !== undefined &&
    record.longitude !== null &&
    record.longitude !== undefined
  );
}
