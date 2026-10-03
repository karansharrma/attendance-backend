import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { ValidationError, validate } from 'class-validator';
import { MyAttendanceQueryDto } from './my-attendance-query.dto';
import { SyncAttendanceDto } from './sync-attendance.dto';

// Same options as the global ValidationPipe in src/common/bootstrap.ts.
const VALIDATOR_OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

async function validateSync(body: unknown): Promise<ValidationError[]> {
  const dto = plainToInstance(SyncAttendanceDto, body, { enableImplicitConversion: false });
  return validate(dto, VALIDATOR_OPTIONS);
}

/** Flatten nested errors into "path: constraint" strings for readable assertions. */
function flatten(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((error) => {
    const path = prefix ? `${prefix}.${error.property}` : error.property;
    const own = Object.keys(error.constraints ?? {}).map((key) => `${path}: ${key}`);
    return [...own, ...flatten(error.children ?? [], path)];
  });
}

const legacyRecord = {
  id: '0f3d5a1e-9c44-4a0b-8e51-6c9f0c1a2b3d',
  timestamp: '2026-10-01T08:00:00.000Z',
  latitude: 12.9716,
  longitude: 77.5946,
  matchedSiteId: null,
  faceMatchConfidence: 0.874,
  status: 'VERIFIED',
  isMockLocation: false,
};

describe('SyncAttendanceDto validation', () => {
  it('accepts a legacy payload without punchType', async () => {
    expect(flatten(await validateSync({ records: [legacyRecord] }))).toEqual([]);
  });

  it('accepts a legacy payload without punchType and with null coordinates', async () => {
    const errors = await validateSync({
      records: [{ ...legacyRecord, latitude: null, longitude: null, status: 'UNRESTRICTED' }],
    });
    expect(flatten(errors)).toEqual([]);
  });

  it('accepts a payload with the coordinate keys absent', async () => {
    const { latitude, longitude, ...withoutCoordinates } = legacyRecord;
    void latitude;
    void longitude;
    expect(flatten(await validateSync({ records: [withoutCoordinates] }))).toEqual([]);
  });

  it('accepts both punch types', async () => {
    for (const punchType of ['IN', 'OUT']) {
      expect(flatten(await validateSync({ records: [{ ...legacyRecord, punchType }] }))).toEqual(
        [],
      );
    }
  });

  it('rejects an invalid punchType', async () => {
    const errors = flatten(
      await validateSync({ records: [{ ...legacyRecord, punchType: 'BREAK' }] }),
    );
    expect(errors).toEqual(['records.0.punchType: isEnum']);
  });

  it('still range-checks coordinates when present', async () => {
    const errors = flatten(
      await validateSync({ records: [{ ...legacyRecord, latitude: 999, longitude: 200 }] }),
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        'records.0.latitude: isLatitude',
        'records.0.longitude: isLongitude',
      ]),
    );
  });

  it('still rejects unknown fields', async () => {
    const errors = flatten(
      await validateSync({ records: [{ ...legacyRecord, accuracyMeters: 5 }] }),
    );
    expect(errors).toEqual(['records.0.accuracyMeters: whitelistValidation']);
  });
});

describe('MyAttendanceQueryDto validation', () => {
  const validateQuery = (query: Record<string, string>) =>
    validate(plainToInstance(MyAttendanceQueryDto, query), VALIDATOR_OPTIONS);

  it('accepts from/to/page/limit as query strings', async () => {
    const dto = plainToInstance(MyAttendanceQueryDto, {
      from: '2026-10-01T00:00:00Z',
      to: '2026-11-01T00:00:00Z',
      page: '3',
      limit: '20',
    });
    expect(await validate(dto, VALIDATOR_OPTIONS)).toEqual([]);
    expect(dto.skip).toBe(40);
  });

  it('rejects a non-ISO from', async () => {
    expect(flatten(await validateQuery({ from: 'yesterday' }))).toEqual(['from: isIso8601']);
  });

  it('rejects an unknown query parameter', async () => {
    expect(flatten(await validateQuery({ employeeId: 'x' }))).toEqual([
      'employeeId: whitelistValidation',
    ]);
  });
});
