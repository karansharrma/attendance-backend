import { AttendanceStatus, PrismaClient, ReviewStatus, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();

const BCRYPT_ROUNDS = 10;

/**
 * Development seed: one admin, three employees covering all three geofence cases, two sites,
 * and a fortnight of attendance so the analytics endpoint has a shape to return.
 *
 * Idempotent -- upserts by email and by deterministic site name, so re-running it is safe.
 */
async function main(): Promise<void> {
  const password = process.env.SEED_PASSWORD ?? 'ChangeMe123!';
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const headOffice = await prisma.site.upsert({
    where: { id: SITE_HEAD_OFFICE },
    update: {},
    create: {
      id: SITE_HEAD_OFFICE,
      name: 'Head Office',
      latitude: 12.9716,
      longitude: 77.5946,
      radiusMeters: 150,
    },
  });

  const warehouse = await prisma.site.upsert({
    where: { id: SITE_WAREHOUSE },
    update: {},
    create: {
      id: SITE_WAREHOUSE,
      name: 'North Warehouse',
      latitude: 13.0359,
      longitude: 77.5972,
      radiusMeters: 250,
    },
  });

  const admin = await prisma.employee.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      name: 'Ada Admin',
      email: 'admin@example.com',
      passwordHash,
      role: Role.ADMIN,
    },
  });

  // Assigned to one site: punch-ins outside Head Office are flagged for review.
  const officeWorker = await prisma.employee.upsert({
    where: { email: 'office@example.com' },
    update: {},
    create: {
      name: 'Owen Office',
      email: 'office@example.com',
      passwordHash,
      role: Role.EMPLOYEE,
      sites: { create: [{ siteId: headOffice.id }] },
    },
  });

  // Assigned to both sites: verified at either one.
  const driver = await prisma.employee.upsert({
    where: { email: 'driver@example.com' },
    update: {},
    create: {
      name: 'Dana Driver',
      email: 'driver@example.com',
      passwordHash,
      role: Role.EMPLOYEE,
      sites: { create: [{ siteId: headOffice.id }, { siteId: warehouse.id }] },
    },
  });

  // No sites at all plus the explicit flag: every punch-in is UNRESTRICTED.
  const fieldTech = await prisma.employee.upsert({
    where: { email: 'field@example.com' },
    update: {},
    create: {
      name: 'Frank Field',
      email: 'field@example.com',
      passwordHash,
      role: Role.EMPLOYEE,
      isUnrestricted: true,
    },
  });

  const existingRecords = await prisma.attendanceRecord.count();
  if (existingRecords === 0) {
    await prisma.attendanceRecord.createMany({
      data: buildAttendanceHistory([
        { employee: officeWorker.id, siteId: headOffice.id },
        { employee: driver.id, siteId: warehouse.id },
        { employee: fieldTech.id, siteId: null },
      ]),
    });
  }

  console.log('Seed complete.');
  console.log(`  admin:    admin@example.com  / ${password}`);
  console.log(`  employee: office@example.com / ${password}   (Head Office only)`);
  console.log(`  employee: driver@example.com / ${password}   (both sites)`);
  console.log(`  employee: field@example.com  / ${password}   (unrestricted)`);
  console.log(`  admin id: ${admin.id}`);
}

interface HistorySpec {
  employee: string;
  siteId: string | null;
}

function buildAttendanceHistory(specs: HistorySpec[]) {
  const rows = [];
  const now = new Date();

  for (let dayOffset = 13; dayOffset >= 0; dayOffset -= 1) {
    const day = new Date(now);
    day.setDate(day.getDate() - dayOffset);

    // Skip weekends so the daily trend has a realistic shape rather than a flat line.
    if (day.getDay() === 0 || day.getDay() === 6) continue;

    for (const spec of specs) {
      // Nudge the arrival time around 09:00 so some days land past the late cut-off.
      const minutes = 540 + ((dayOffset * 17) % 45) - 10;
      const timestamp = new Date(day);
      timestamp.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);

      const offSite = spec.siteId !== null && dayOffset % 7 === 3;
      const status =
        spec.siteId === null
          ? AttendanceStatus.UNRESTRICTED
          : offSite
            ? AttendanceStatus.FLAGGED_OUTSIDE_GEOFENCE
            : AttendanceStatus.VERIFIED;

      rows.push({
        id: randomUUID(),
        employeeId: spec.employee,
        timestamp,
        latitude: 12.9716 + (offSite ? 0.05 : 0.0004),
        longitude: 77.5946 + (offSite ? 0.05 : 0.0004),
        matchedSiteId: status === AttendanceStatus.VERIFIED ? spec.siteId : null,
        faceMatchConfidence: 0.81 + (dayOffset % 5) * 0.03,
        status,
        isMockLocation: false,
        reviewStatus:
          status === AttendanceStatus.FLAGGED_OUTSIDE_GEOFENCE
            ? ReviewStatus.PENDING
            : ReviewStatus.APPROVED,
      });
    }
  }

  return rows;
}

// Fixed ids so re-running the seed updates the same sites instead of creating new ones.
const SITE_HEAD_OFFICE = '11111111-1111-4111-8111-111111111111';
const SITE_WAREHOUSE = '22222222-2222-4222-8222-222222222222';

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
