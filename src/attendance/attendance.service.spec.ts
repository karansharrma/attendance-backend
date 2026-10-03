import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { AttendanceStatus, PunchType, ReviewStatus, Role } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import type { NotificationsService } from '../notifications/notifications.service';
import type { PrismaService } from '../prisma/prisma.service';
import { AttendanceService } from './attendance.service';
import { MyAttendanceQueryDto } from './dto/my-attendance-query.dto';
import { SyncAttendanceRecordDto } from './dto/sync-attendance.dto';

const EMPLOYEE_ID = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const OTHER_EMPLOYEE_ID = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const RECORD_ID = '0f3d5a1e-9c44-4a0b-8e51-6c9f0c1a2b3d';
const PUNCH_IN_ID = '1e2d3c4b-5a69-4788-9a6b-5c4d3e2f1a0b';
const SITE_ID = '11111111-2222-4333-8444-555555555555';

const user: AuthenticatedUser = { sub: EMPLOYEE_ID, email: 'e@example.com', role: Role.EMPLOYEE };

function makePrismaMock() {
  return {
    attendanceRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    site: { findMany: jest.fn().mockResolvedValue([]) },
    employee: {
      findUnique: jest.fn().mockResolvedValue({ isUnrestricted: true, _count: { sites: 0 } }),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
}

/** A payload as the Android build currently in users' hands sends it: no punchType. */
function legacyRecord(overrides: Partial<SyncAttendanceRecordDto> = {}): SyncAttendanceRecordDto {
  return {
    id: RECORD_ID,
    timestamp: '2026-10-01T08:00:00.000Z',
    latitude: 12.9716,
    longitude: 77.5946,
    faceMatchConfidence: 0.87,
    status: AttendanceStatus.VERIFIED,
    isMockLocation: false,
    ...overrides,
  };
}

describe('AttendanceService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let notifications: { notifyAdminsOfAttendance: jest.Mock };
  let service: AttendanceService;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    prisma = makePrismaMock();
    notifications = { notifyAdminsOfAttendance: jest.fn().mockResolvedValue(undefined) };
    service = new AttendanceService(
      prisma as unknown as PrismaService,
      notifications as unknown as NotificationsService,
    );
  });

  const upsertArgs = () => prisma.attendanceRecord.upsert.mock.calls[0][0];

  describe('sync', () => {
    it('defaults a missing punchType to IN and does not attempt pairing', async () => {
      const response = await service.sync(user, { records: [legacyRecord()] });

      expect(response).toMatchObject({
        accepted: 1,
        rejected: 0,
        results: [{ id: RECORD_ID, outcome: 'created' }],
      });
      expect(upsertArgs().create).toMatchObject({
        id: RECORD_ID,
        employeeId: EMPLOYEE_ID,
        punchType: PunchType.IN,
        reviewStatus: ReviewStatus.PENDING,
      });
      expect(upsertArgs().update.punchType).toBe(PunchType.IN);
      expect(prisma.attendanceRecord.findFirst).not.toHaveBeenCalled();
      expect(notifications.notifyAdminsOfAttendance).toHaveBeenCalledWith(
        EMPLOYEE_ID,
        expect.objectContaining({ id: RECORD_ID, punchType: PunchType.IN }),
      );
    });

    it('pairs an OUT with the latest unpaired IN and computes shiftDurationMinutes', async () => {
      prisma.attendanceRecord.findFirst.mockResolvedValue({
        id: PUNCH_IN_ID,
        timestamp: new Date('2026-10-01T08:00:00.000Z'),
      });

      const response = await service.sync(user, {
        records: [
          legacyRecord({ timestamp: '2026-10-01T17:30:45.000Z', punchType: PunchType.OUT }),
        ],
      });

      expect(response.accepted).toBe(1);
      expect(prisma.attendanceRecord.findFirst).toHaveBeenCalledWith({
        where: {
          employeeId: EMPLOYEE_ID,
          punchType: PunchType.IN,
          pairedPunchId: null,
          timestamp: { lt: new Date('2026-10-01T17:30:45.000Z') },
        },
        orderBy: { timestamp: 'desc' },
      });
      expect(prisma.attendanceRecord.updateMany).toHaveBeenCalledWith({
        where: { id: PUNCH_IN_ID, pairedPunchId: null },
        data: { pairedPunchId: RECORD_ID },
      });
      expect(prisma.attendanceRecord.update).toHaveBeenCalledWith({
        where: { id: RECORD_ID },
        data: { pairedPunchId: PUNCH_IN_ID, shiftDurationMinutes: 570 },
      });
      expect(notifications.notifyAdminsOfAttendance).toHaveBeenCalledWith(
        EMPLOYEE_ID,
        expect.objectContaining({ punchType: PunchType.OUT }),
      );
    });

    it('stores an OUT with no unpaired IN without crashing', async () => {
      const response = await service.sync(user, {
        records: [legacyRecord({ punchType: PunchType.OUT })],
      });

      expect(response).toMatchObject({ accepted: 1, rejected: 0 });
      expect(response.results[0].outcome).toBe('created');
      expect(prisma.attendanceRecord.updateMany).not.toHaveBeenCalled();
      expect(prisma.attendanceRecord.update).not.toHaveBeenCalled();
    });

    it('does not pair when the IN was claimed concurrently', async () => {
      prisma.attendanceRecord.findFirst.mockResolvedValue({
        id: PUNCH_IN_ID,
        timestamp: new Date('2026-10-01T08:00:00.000Z'),
      });
      prisma.attendanceRecord.updateMany.mockResolvedValue({ count: 0 });

      const response = await service.sync(user, {
        records: [
          legacyRecord({ timestamp: '2026-10-01T17:00:00.000Z', punchType: PunchType.OUT }),
        ],
      });

      expect(response.accepted).toBe(1);
      expect(prisma.attendanceRecord.update).not.toHaveBeenCalled();
    });

    it('is idempotent when the same id is re-synced', async () => {
      prisma.attendanceRecord.findUnique.mockResolvedValue({
        id: RECORD_ID,
        employeeId: EMPLOYEE_ID,
        punchType: PunchType.OUT,
        pairedPunchId: PUNCH_IN_ID,
      });

      const response = await service.sync(user, {
        records: [legacyRecord({ punchType: PunchType.OUT })],
      });

      expect(response.results).toEqual([{ id: RECORD_ID, outcome: 'updated' }]);
      const { update } = upsertArgs();
      // Admin-owned and server-computed fields are never touched by a replay.
      for (const key of [
        'reviewStatus',
        'reviewedByAdminId',
        'reviewedAt',
        'reviewNote',
        'pairedPunchId',
        'shiftDurationMinutes',
      ]) {
        expect(update).not.toHaveProperty(key);
      }
      expect(prisma.attendanceRecord.findFirst).not.toHaveBeenCalled();
      expect(prisma.attendanceRecord.updateMany).not.toHaveBeenCalled();
      expect(prisma.attendanceRecord.update).not.toHaveBeenCalled();
      expect(notifications.notifyAdminsOfAttendance).not.toHaveBeenCalled();
    });

    it('keeps the stored punchType when a legacy client re-syncs without one', async () => {
      prisma.attendanceRecord.findUnique.mockResolvedValue({
        id: RECORD_ID,
        employeeId: EMPLOYEE_ID,
        punchType: PunchType.OUT,
        pairedPunchId: PUNCH_IN_ID,
      });

      await service.sync(user, { records: [legacyRecord()] });

      expect(upsertArgs().update.punchType).toBe(PunchType.OUT);
    });

    it('completes a pairing on retry when the first attempt stored the OUT but did not pair it', async () => {
      prisma.attendanceRecord.findUnique.mockResolvedValue({
        id: RECORD_ID,
        employeeId: EMPLOYEE_ID,
        punchType: PunchType.OUT,
        pairedPunchId: null,
      });
      prisma.attendanceRecord.findFirst.mockResolvedValue({
        id: PUNCH_IN_ID,
        timestamp: new Date('2026-10-01T07:00:00.000Z'),
      });

      await service.sync(user, { records: [legacyRecord({ punchType: PunchType.OUT })] });

      expect(prisma.attendanceRecord.update).toHaveBeenCalledWith({
        where: { id: RECORD_ID },
        data: { pairedPunchId: PUNCH_IN_ID, shiftDurationMinutes: 60 },
      });
    });

    it('collapses an id repeated inside one batch into a single upsert', async () => {
      await service.sync(user, { records: [legacyRecord(), legacyRecord()] });
      expect(prisma.attendanceRecord.upsert).toHaveBeenCalledTimes(1);
    });

    it('accepts null coordinates for an unrestricted employee', async () => {
      const response = await service.sync(user, {
        records: [
          legacyRecord({
            latitude: null,
            longitude: null,
            status: AttendanceStatus.UNRESTRICTED,
          }),
        ],
      });

      expect(response.results).toEqual([{ id: RECORD_ID, outcome: 'created' }]);
      expect(upsertArgs().create).toMatchObject({
        latitude: null,
        longitude: null,
        status: AttendanceStatus.UNRESTRICTED,
      });
    });

    it('accepts missing coordinates (keys absent) as null', async () => {
      const record = legacyRecord({ status: AttendanceStatus.UNRESTRICTED });
      delete record.latitude;
      delete record.longitude;

      await service.sync(user, { records: [record] });

      expect(upsertArgs().create).toMatchObject({ latitude: null, longitude: null });
    });

    it('never stores a record without coordinates as VERIFIED', async () => {
      const response = await service.sync(user, {
        records: [legacyRecord({ latitude: null, longitude: null })],
      });

      expect(response.results[0].outcome).toBe('created');
      expect(response.results[0].message).toMatch(/cannot be confirmed without coordinates/);
      expect(upsertArgs().create.status).toBe(AttendanceStatus.FLAGGED_OUTSIDE_GEOFENCE);
      expect(upsertArgs().update.status).toBe(AttendanceStatus.FLAGGED_OUTSIDE_GEOFENCE);
    });

    it('flags an UNRESTRICTED record without coordinates from a site-bound employee', async () => {
      prisma.employee.findUnique.mockResolvedValue({ isUnrestricted: false, _count: { sites: 2 } });

      await service.sync(user, {
        records: [
          legacyRecord({ latitude: null, longitude: null, status: AttendanceStatus.UNRESTRICTED }),
        ],
      });

      expect(upsertArgs().create.status).toBe(AttendanceStatus.FLAGGED_OUTSIDE_GEOFENCE);
    });

    it('does not look up the employee when every record has coordinates', async () => {
      await service.sync(user, { records: [legacyRecord()] });
      expect(prisma.employee.findUnique).not.toHaveBeenCalled();
      expect(upsertArgs().create.status).toBe(AttendanceStatus.VERIFIED);
    });

    it('rejects, per record, a record with only one coordinate', async () => {
      const response = await service.sync(user, {
        records: [legacyRecord({ latitude: 12.97, longitude: null })],
      });

      expect(response).toMatchObject({ accepted: 0, rejected: 1 });
      expect(response.results[0]).toMatchObject({ outcome: 'rejected' });
      expect(prisma.attendanceRecord.upsert).not.toHaveBeenCalled();
    });

    it('rejects the whole batch when a record names another employee', async () => {
      await expect(
        service.sync(user, {
          records: [legacyRecord({ employeeId: OTHER_EMPLOYEE_ID })],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.attendanceRecord.upsert).not.toHaveBeenCalled();
    });

    it('rejects a record whose id already belongs to another employee', async () => {
      prisma.attendanceRecord.findUnique.mockResolvedValue({
        id: RECORD_ID,
        employeeId: OTHER_EMPLOYEE_ID,
        punchType: PunchType.IN,
        pairedPunchId: null,
      });

      const response = await service.sync(user, { records: [legacyRecord()] });

      expect(response).toMatchObject({ accepted: 0, rejected: 1 });
      expect(prisma.attendanceRecord.upsert).not.toHaveBeenCalled();
    });

    it('still accepts the record when the notification fails', async () => {
      notifications.notifyAdminsOfAttendance.mockRejectedValue(new Error('fcm down'));
      const response = await service.sync(user, { records: [legacyRecord()] });
      expect(response).toMatchObject({ accepted: 1, rejected: 0 });
    });
  });

  describe('findMine', () => {
    const query = (overrides: Partial<MyAttendanceQueryDto> = {}): MyAttendanceQueryDto =>
      Object.assign(new MyAttendanceQueryDto(), { page: 2, limit: 10 }, overrides);

    const storedRow = {
      id: RECORD_ID,
      employeeId: EMPLOYEE_ID,
      timestamp: new Date('2026-10-01T17:00:00.000Z'),
      latitude: null,
      longitude: null,
      matchedSiteId: SITE_ID,
      faceMatchConfidence: 0.9,
      status: AttendanceStatus.UNRESTRICTED,
      isMockLocation: false,
      punchType: PunchType.OUT,
      pairedPunchId: PUNCH_IN_ID,
      shiftDurationMinutes: 480,
      reviewedByAdminId: 'admin-id',
      reviewedAt: new Date('2026-10-02T09:00:00.000Z'),
      reviewNote: 'ok',
      reviewStatus: ReviewStatus.APPROVED,
      createdAt: new Date('2026-10-01T17:00:05.000Z'),
      updatedAt: new Date('2026-10-02T09:00:00.000Z'),
    };

    it("returns only the caller's records, newest first, paginated", async () => {
      prisma.attendanceRecord.findMany.mockResolvedValue([storedRow]);
      prisma.attendanceRecord.count.mockResolvedValue(11);
      prisma.site.findMany.mockResolvedValue([{ id: SITE_ID, name: 'Head Office' }]);

      const result = await service.findMine(
        user,
        query({ from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' }),
      );

      const expectedWhere = {
        employeeId: EMPLOYEE_ID,
        timestamp: {
          gte: new Date('2026-10-01T00:00:00Z'),
          lt: new Date('2026-11-01T00:00:00Z'),
        },
      };
      expect(prisma.attendanceRecord.findMany).toHaveBeenCalledWith({
        where: expectedWhere,
        orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
        skip: 10,
        take: 10,
      });
      expect(prisma.attendanceRecord.count).toHaveBeenCalledWith({ where: expectedWhere });

      expect(result.meta).toEqual({
        total: 11,
        page: 2,
        limit: 10,
        totalPages: 2,
        hasNextPage: false,
      });
      expect(result.data).toEqual([
        {
          id: RECORD_ID,
          employeeId: EMPLOYEE_ID,
          timestamp: storedRow.timestamp,
          latitude: null,
          longitude: null,
          matchedSiteId: SITE_ID,
          matchedSiteName: 'Head Office',
          faceMatchConfidence: 0.9,
          status: AttendanceStatus.UNRESTRICTED,
          isMockLocation: false,
          punchType: PunchType.OUT,
          pairedPunchId: PUNCH_IN_ID,
          shiftDurationMinutes: 480,
          reviewStatus: ReviewStatus.APPROVED,
          reviewedAt: storedRow.reviewedAt,
          reviewNote: 'ok',
          createdAt: storedRow.createdAt,
        },
      ]);
      // Admin identity is not exposed to employees.
      expect(result.data[0]).not.toHaveProperty('reviewedByAdminId');
    });

    it('omits the timestamp filter when no range is given and nulls a deleted site name', async () => {
      prisma.attendanceRecord.findMany.mockResolvedValue([storedRow]);
      prisma.attendanceRecord.count.mockResolvedValue(1);

      const result = await service.findMine(user, query({ page: 1 }));

      expect(prisma.attendanceRecord.findMany.mock.calls[0][0].where).toEqual({
        employeeId: EMPLOYEE_ID,
      });
      expect(result.data[0].matchedSiteName).toBeNull();
    });

    it('rejects an empty or inverted range', async () => {
      await expect(
        service.findMine(user, query({ from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.attendanceRecord.findMany).not.toHaveBeenCalled();
    });
  });
});
