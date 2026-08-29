import { AttendanceStatus, ReviewStatus, Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Harness, createHarness, prefix, seedEmployee, seedSite } from './test-harness';

interface Credentials {
  id: string;
  accessToken: string;
}

describe('Attendance sync (e2e)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.prisma.truncateAll();
  });

  const login = async (email: string, password: string): Promise<Credentials> => {
    const response = await request(harness.app.getHttpServer())
      .post(prefix('/auth/login'))
      .send({ email, password })
      .expect(200);
    return { id: response.body.employee.id, accessToken: response.body.accessToken };
  };

  const buildRecord = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    latitude: 12.9716,
    longitude: 77.5946,
    faceMatchConfidence: 0.87,
    status: AttendanceStatus.VERIFIED,
    isMockLocation: false,
    ...overrides,
  });

  const sync = (token: string, records: unknown[]) =>
    request(harness.app.getHttpServer())
      .post(prefix('/attendance/sync'))
      .set('Authorization', `Bearer ${token}`)
      .send({ records });

  it('stores a batch and reports one result per record', async () => {
    const user = await seedEmployee(harness.prisma, { email: 'sync1@example.com' });
    const auth = await login(user.email, user.password);
    const site = await seedSite(harness.prisma);

    const records = [
      buildRecord({ matchedSiteId: site.id }),
      buildRecord({ status: AttendanceStatus.FLAGGED_OUTSIDE_GEOFENCE }),
    ];

    const response = await sync(auth.accessToken, records).expect(200);

    expect(response.body.accepted).toBe(2);
    expect(response.body.rejected).toBe(0);
    expect(response.body.results).toHaveLength(2);
    expect(response.body.results.every((r: { outcome: string }) => r.outcome === 'created')).toBe(
      true,
    );

    const stored = await harness.prisma.attendanceRecord.count({ where: { employeeId: user.id } });
    expect(stored).toBe(2);
  });

  it('accepts an in-range face confidence with model precision', async () => {
    const user = await seedEmployee(harness.prisma, { email: 'sync-precision@example.com' });
    const auth = await login(user.email, user.password);

    await sync(auth.accessToken, [buildRecord({ faceMatchConfidence: 0.874391276543 })]).expect(
      200,
    );
  });

  it('is idempotent: replaying the identical batch creates no duplicates', async () => {
    const user = await seedEmployee(harness.prisma, { email: 'sync2@example.com' });
    const auth = await login(user.email, user.password);

    const records = [buildRecord(), buildRecord(), buildRecord()];

    const first = await sync(auth.accessToken, records).expect(200);
    expect(first.body.results.every((r: { outcome: string }) => r.outcome === 'created')).toBe(
      true,
    );

    // Exactly what the mobile sync worker does when a response is lost in transit.
    const second = await sync(auth.accessToken, records).expect(200);
    expect(second.body.accepted).toBe(3);
    expect(second.body.results.every((r: { outcome: string }) => r.outcome === 'updated')).toBe(
      true,
    );

    expect(await harness.prisma.attendanceRecord.count()).toBe(3);
  });

  it('collapses an id repeated inside a single batch', async () => {
    const user = await seedEmployee(harness.prisma, { email: 'sync3@example.com' });
    const auth = await login(user.email, user.password);

    const duplicated = buildRecord();
    const response = await sync(auth.accessToken, [duplicated, { ...duplicated }]).expect(200);

    expect(response.body.results).toHaveLength(1);
    expect(await harness.prisma.attendanceRecord.count()).toBe(1);
  });

  it('does not let a replay reset an admin review decision', async () => {
    const employee = await seedEmployee(harness.prisma, { email: 'sync4@example.com' });
    const admin = await seedEmployee(harness.prisma, {
      email: 'reviewer@example.com',
      role: Role.ADMIN,
    });
    const employeeAuth = await login(employee.email, employee.password);
    const adminAuth = await login(admin.email, admin.password);

    const record = buildRecord({ status: AttendanceStatus.FLAGGED_OUTSIDE_GEOFENCE });
    await sync(employeeAuth.accessToken, [record]).expect(200);

    await request(harness.app.getHttpServer())
      .patch(prefix(`/admin/attendance/${record.id}/review`))
      .set('Authorization', `Bearer ${adminAuth.accessToken}`)
      .send({ reviewStatus: ReviewStatus.APPROVED, note: 'Called ahead, working from the depot' })
      .expect(200);

    // The device re-pushes the same record; the approval must survive it.
    await sync(employeeAuth.accessToken, [record]).expect(200);

    const stored = await harness.prisma.attendanceRecord.findUniqueOrThrow({
      where: { id: record.id },
    });
    expect(stored.reviewStatus).toBe(ReviewStatus.APPROVED);
    expect(stored.reviewedByAdminId).toBe(admin.id);
    expect(stored.reviewNote).toBe('Called ahead, working from the depot');
  });

  it('refuses a batch containing another employee record', async () => {
    const attacker = await seedEmployee(harness.prisma, { email: 'attacker@example.com' });
    const victim = await seedEmployee(harness.prisma, { email: 'victim@example.com' });
    const auth = await login(attacker.email, attacker.password);

    const response = await sync(auth.accessToken, [buildRecord({ employeeId: victim.id })]).expect(
      403,
    );

    expect(response.body.statusCode).toBe(403);
    expect(await harness.prisma.attendanceRecord.count()).toBe(0);
  });

  it('files records under the token holder even when employeeId is omitted', async () => {
    const user = await seedEmployee(harness.prisma, { email: 'sync5@example.com' });
    const auth = await login(user.email, user.password);

    await sync(auth.accessToken, [buildRecord()]).expect(200);

    const stored = await harness.prisma.attendanceRecord.findFirstOrThrow();
    expect(stored.employeeId).toBe(user.id);
  });

  it('flags a mock-location record in the result while still storing it', async () => {
    const user = await seedEmployee(harness.prisma, { email: 'sync6@example.com' });
    const auth = await login(user.email, user.password);

    const response = await sync(auth.accessToken, [
      buildRecord({ isMockLocation: true, status: AttendanceStatus.FLAGGED_OUTSIDE_GEOFENCE }),
    ]).expect(200);

    expect(response.body.results[0].message).toMatch(/mock location/i);
    expect(await harness.prisma.attendanceRecord.count()).toBe(1);
  });

  it('rejects malformed records with 400 and per-field messages', async () => {
    const user = await seedEmployee(harness.prisma, { email: 'sync7@example.com' });
    const auth = await login(user.email, user.password);

    const response = await sync(auth.accessToken, [
      {
        id: 'not-a-uuid',
        timestamp: 'yesterday',
        latitude: 999,
        longitude: 77.5946,
        faceMatchConfidence: 4,
        status: 'MAYBE',
        isMockLocation: 'no',
      },
    ]).expect(400);

    expect(Array.isArray(response.body.message)).toBe(true);
    expect(await harness.prisma.attendanceRecord.count()).toBe(0);
  });

  it('rejects an empty batch', async () => {
    const user = await seedEmployee(harness.prisma, { email: 'sync8@example.com' });
    const auth = await login(user.email, user.password);

    await sync(auth.accessToken, []).expect(400);
  });

  it('requires authentication', async () => {
    await request(harness.app.getHttpServer())
      .post(prefix('/attendance/sync'))
      .send({ records: [buildRecord()] })
      .expect(401);
  });

  it('keeps a record readable after the site it matched has been deleted', async () => {
    const user = await seedEmployee(harness.prisma, { email: 'sync9@example.com' });
    const admin = await seedEmployee(harness.prisma, {
      email: 'siteadmin@example.com',
      role: Role.ADMIN,
    });
    const auth = await login(user.email, user.password);
    const adminAuth = await login(admin.email, admin.password);
    const site = await seedSite(harness.prisma, { name: 'Doomed Site' });

    await sync(auth.accessToken, [buildRecord({ matchedSiteId: site.id })]).expect(200);

    await request(harness.app.getHttpServer())
      .delete(prefix(`/admin/sites/${site.id}`))
      .set('Authorization', `Bearer ${adminAuth.accessToken}`)
      .expect(200);

    const listed = await request(harness.app.getHttpServer())
      .get(prefix('/admin/attendance'))
      .set('Authorization', `Bearer ${adminAuth.accessToken}`)
      .expect(200);

    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].matchedSiteId).toBe(site.id);
    expect(listed.body.data[0].matchedSiteName).toBeNull();
  });
});
