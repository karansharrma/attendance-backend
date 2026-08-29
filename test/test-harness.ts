import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { API_PREFIX, configureApp } from '../src/common/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';

export const prefix = (path: string): string => `/${API_PREFIX}${path}`;

export interface Harness {
  app: INestApplication;
  prisma: PrismaService;
  close(): Promise<void>;
}

/**
 * Boots the real application graph against a real Postgres.
 *
 * The only thing stubbed out is the throttler: the auth suite deliberately makes more login
 * attempts than the production rate limit allows, and a shared 5-per-minute bucket would
 * make the tests order-dependent. Rate limiting is exercised in its own test, which opts
 * back in.
 */
export async function createHarness(options: { throttling?: boolean } = {}): Promise<Harness> {
  process.env.NODE_ENV = 'test';

  const builder: TestingModule = await (
    options.throttling
      ? Test.createTestingModule({ imports: [AppModule] })
      : Test.createTestingModule({ imports: [AppModule] })
          .overrideGuard(ThrottlerGuard)
          .useValue({
            canActivate: () => true,
          })
  ).compile();

  const app = builder.createNestApplication();
  configureApp(app);
  await app.init();

  const prisma = app.get(PrismaService);
  await prisma.truncateAll();

  return {
    app,
    prisma,
    async close() {
      await prisma.truncateAll();
      await app.close();
    },
  };
}

export interface SeededUser {
  id: string;
  email: string;
  password: string;
  role: Role;
}

export async function seedEmployee(
  prisma: PrismaService,
  overrides: Partial<{
    email: string;
    password: string;
    role: Role;
    isUnrestricted: boolean;
    name: string;
  }> = {},
): Promise<SeededUser> {
  const password = overrides.password ?? 'CorrectHorse123!';
  const email = overrides.email ?? `user-${randomUUID()}@example.com`;

  const employee = await prisma.employee.create({
    data: {
      name: overrides.name ?? 'Test Employee',
      email,
      passwordHash: await bcrypt.hash(password, 10),
      role: overrides.role ?? Role.EMPLOYEE,
      isUnrestricted: overrides.isUnrestricted ?? false,
    },
  });

  return { id: employee.id, email, password, role: employee.role };
}

export async function seedSite(
  prisma: PrismaService,
  overrides: Partial<{
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
  }> = {},
): Promise<{ id: string; name: string }> {
  const site = await prisma.site.create({
    data: {
      name: overrides.name ?? 'Test Site',
      latitude: overrides.latitude ?? 12.9716,
      longitude: overrides.longitude ?? 77.5946,
      radiusMeters: overrides.radiusMeters ?? 150,
    },
  });
  return { id: site.id, name: site.name };
}
