import { Role } from '@prisma/client';
import request from 'supertest';
import { Harness, createHarness, prefix, seedEmployee } from './test-harness';

describe('Auth (e2e)', () => {
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

  describe('POST /auth/login', () => {
    it('returns an access/refresh pair and the caller profile', async () => {
      const user = await seedEmployee(harness.prisma, { email: 'login@example.com' });

      const response = await request(harness.app.getHttpServer())
        .post(prefix('/auth/login'))
        .send({ email: user.email, password: user.password })
        .expect(200);

      expect(response.body).toMatchObject({
        tokenType: 'Bearer',
        employee: { id: user.id, email: user.email, role: Role.EMPLOYEE },
      });
      expect(typeof response.body.accessToken).toBe('string');
      expect(typeof response.body.refreshToken).toBe('string');
      expect(response.body.accessToken).not.toEqual(response.body.refreshToken);
    });

    it('never leaks the password hash or the face embedding', async () => {
      const user = await seedEmployee(harness.prisma, { email: 'leak@example.com' });
      await harness.prisma.employee.update({
        where: { id: user.id },
        data: { faceEmbedding: Buffer.alloc(512), embeddingModelVersion: 'mobilefacenet-v1' },
      });

      const response = await request(harness.app.getHttpServer())
        .post(prefix('/auth/login'))
        .send({ email: user.email, password: user.password })
        .expect(200);

      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain('passwordHash');
      expect(serialised).not.toContain('faceEmbedding');
    });

    it('rejects a wrong password with 401 and the standard error shape', async () => {
      const user = await seedEmployee(harness.prisma, { email: 'wrongpw@example.com' });

      const response = await request(harness.app.getHttpServer())
        .post(prefix('/auth/login'))
        .send({ email: user.email, password: 'NotThePassword1!' })
        .expect(401);

      expect(response.body).toMatchObject({
        statusCode: 401,
        error: expect.any(String),
        message: 'Invalid email or password',
      });
    });

    it('gives an unknown email the same message as a wrong password', async () => {
      const response = await request(harness.app.getHttpServer())
        .post(prefix('/auth/login'))
        .send({ email: 'nobody@example.com', password: 'CorrectHorse123!' })
        .expect(401);

      expect(response.body.message).toBe('Invalid email or password');
    });

    it('rejects a malformed payload with per-field validation messages', async () => {
      const response = await request(harness.app.getHttpServer())
        .post(prefix('/auth/login'))
        .send({ email: 'not-an-email', password: 'short' })
        .expect(400);

      expect(response.body.statusCode).toBe(400);
      expect(Array.isArray(response.body.message)).toBe(true);
      expect(response.body.message.join(' ')).toMatch(/email/i);
      expect(response.body.message.join(' ')).toMatch(/password/i);
    });

    it('rejects undeclared fields rather than silently ignoring them', async () => {
      const user = await seedEmployee(harness.prisma, { email: 'extra@example.com' });

      await request(harness.app.getHttpServer())
        .post(prefix('/auth/login'))
        .send({ email: user.email, password: user.password, role: 'ADMIN' })
        .expect(400);
    });
  });

  describe('POST /auth/refresh', () => {
    it('issues a new token pair from a valid refresh token', async () => {
      const user = await seedEmployee(harness.prisma, { email: 'refresh@example.com' });

      const login = await request(harness.app.getHttpServer())
        .post(prefix('/auth/login'))
        .send({ email: user.email, password: user.password })
        .expect(200);

      const response = await request(harness.app.getHttpServer())
        .post(prefix('/auth/refresh'))
        .send({ refreshToken: login.body.refreshToken })
        .expect(200);

      expect(response.body).toMatchObject({ tokenType: 'Bearer' });
      expect(typeof response.body.accessToken).toBe('string');
      expect(typeof response.body.refreshToken).toBe('string');
    });

    it('refuses an access token presented as a refresh token', async () => {
      const user = await seedEmployee(harness.prisma, { email: 'swap@example.com' });

      const login = await request(harness.app.getHttpServer())
        .post(prefix('/auth/login'))
        .send({ email: user.email, password: user.password })
        .expect(200);

      await request(harness.app.getHttpServer())
        .post(prefix('/auth/refresh'))
        .send({ refreshToken: login.body.accessToken })
        .expect(401);
    });

    it('refuses a refresh token whose account has since been deleted', async () => {
      const user = await seedEmployee(harness.prisma, { email: 'deleted@example.com' });

      const login = await request(harness.app.getHttpServer())
        .post(prefix('/auth/login'))
        .send({ email: user.email, password: user.password })
        .expect(200);

      await harness.prisma.employee.delete({ where: { id: user.id } });

      await request(harness.app.getHttpServer())
        .post(prefix('/auth/refresh'))
        .send({ refreshToken: login.body.refreshToken })
        .expect(401);
    });
  });

  describe('Guards', () => {
    it('rejects an unauthenticated call to a protected route', async () => {
      await request(harness.app.getHttpServer())
        .get(prefix('/admin/analytics/summary'))
        .expect(401);
    });

    it('rejects an employee reaching an admin route with 403', async () => {
      const employee = await seedEmployee(harness.prisma, { email: 'grunt@example.com' });

      const login = await request(harness.app.getHttpServer())
        .post(prefix('/auth/login'))
        .send({ email: employee.email, password: employee.password })
        .expect(200);

      await request(harness.app.getHttpServer())
        .get(prefix('/admin/attendance'))
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .expect(403);
    });

    it('lets an admin through the same route', async () => {
      const admin = await seedEmployee(harness.prisma, {
        email: 'boss@example.com',
        role: Role.ADMIN,
      });

      const login = await request(harness.app.getHttpServer())
        .post(prefix('/auth/login'))
        .send({ email: admin.email, password: admin.password })
        .expect(200);

      const response = await request(harness.app.getHttpServer())
        .get(prefix('/admin/attendance'))
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .expect(200);

      expect(response.body).toMatchObject({ data: [], meta: { total: 0, page: 1 } });
    });

    it('leaves the health endpoint public', async () => {
      await request(harness.app.getHttpServer()).get(prefix('/health')).expect(200);
    });
  });
});

describe('Auth rate limiting (e2e)', () => {
  let harness: Harness;

  beforeAll(async () => {
    // Opt back into the real ThrottlerGuard for this suite only.
    harness = await createHarness({ throttling: true });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('locks out repeated login attempts from the same IP with 429', async () => {
    const user = await seedEmployee(harness.prisma, { email: 'bruteforce@example.com' });
    const attempt = () =>
      request(harness.app.getHttpServer())
        .post(prefix('/auth/login'))
        .send({ email: user.email, password: 'DefinitelyWrong1!' });

    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      statuses.push((await attempt()).status);
    }

    expect(statuses).toContain(401);
    expect(statuses).toContain(429);
    // The limiter must engage well before the eighth guess.
    expect(statuses.indexOf(429)).toBeLessThan(8);
  });
});
