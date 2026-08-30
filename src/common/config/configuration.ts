import { plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

/**
 * Every value the app reads from the environment, validated at boot.
 *
 * Failing to start on a missing or weak secret is deliberate: a container that silently
 * comes up with a default JWT secret is worse than one that refuses to come up at all.
 */
export class EnvironmentVariables {
  @IsOptional()
  @IsString()
  NODE_ENV: string = 'development';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  @MinLength(32, { message: 'JWT_ACCESS_SECRET must be at least 32 characters' })
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(32, { message: 'JWT_REFRESH_SECRET must be at least 32 characters' })
  JWT_REFRESH_SECRET!: string;

  @IsOptional()
  @IsString()
  JWT_ACCESS_EXPIRES_IN: string = '15m';

  @IsOptional()
  @IsString()
  JWT_REFRESH_EXPIRES_IN: string = '30d';

  /** Login attempts allowed per IP inside THROTTLE_AUTH_TTL_SECONDS. */
  @IsOptional()
  @IsInt()
  @Min(1)
  THROTTLE_AUTH_LIMIT: number = 5;

  @IsOptional()
  @IsInt()
  @Min(1)
  THROTTLE_AUTH_TTL_SECONDS: number = 60;

  @IsOptional()
  @IsInt()
  @Min(1)
  THROTTLE_GLOBAL_LIMIT: number = 120;

  @IsOptional()
  @IsInt()
  @Min(1)
  THROTTLE_GLOBAL_TTL_SECONDS: number = 60;

  /** Minutes past local midnight after which a punch-in counts as a late arrival. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1439)
  LATE_ARRIVAL_CUTOFF_MINUTES: number = 555;

  /**
   * IANA timezone the analytics day boundary and late-arrival cut-off are evaluated in.
   * A 09:15 cut-off compared in UTC is wrong for every deployment that is not on GMT.
   */
  @IsOptional()
  @IsString()
  REPORTING_TIMEZONE: string = 'UTC';

  /** Cosine-similarity threshold the device applies locally; served by GET /config. */
  @IsOptional()
  FACE_MATCH_THRESHOLD: number = 0.75;

  /** Reject GPS fixes worse than this, device-side. */
  @IsOptional()
  MAX_LOCATION_ACCURACY_METERS: number = 30;

  @IsOptional()
  @IsString()
  EMBEDDING_MODEL_VERSION: string = 'mobilefacenet-v1';

  /** Largest batch a single POST /attendance/sync may carry. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  MAX_SYNC_BATCH_SIZE: number = 200;

  @IsOptional()
  @IsBoolean()
  SWAGGER_ENABLED: boolean = false;

  @IsOptional()
  @IsString()
  CORS_ORIGINS: string = '*';

  /** JSON service-account credential from Firebase console. Leave unset to disable delivery. */
  @IsOptional()
  @IsString()
  FIREBASE_SERVICE_ACCOUNT_JSON?: string;
}

const NUMERIC_KEYS = new Set([
  'PORT',
  'THROTTLE_AUTH_LIMIT',
  'THROTTLE_AUTH_TTL_SECONDS',
  'THROTTLE_GLOBAL_LIMIT',
  'THROTTLE_GLOBAL_TTL_SECONDS',
  'LATE_ARRIVAL_CUTOFF_MINUTES',
  'FACE_MATCH_THRESHOLD',
  'MAX_LOCATION_ACCURACY_METERS',
  'MAX_SYNC_BATCH_SIZE',
]);

const BOOLEAN_KEYS = new Set(['SWAGGER_ENABLED']);

/**
 * Environment variables arrive as strings; coerce the ones that are not before validating,
 * so `PORT=3000` does not fail an @IsInt check on the string "3000".
 */
export function validateEnvironment(raw: Record<string, unknown>): EnvironmentVariables {
  const coerced: Record<string, unknown> = { ...raw };

  for (const key of NUMERIC_KEYS) {
    const value = coerced[key];
    if (value !== undefined && value !== '') {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) coerced[key] = parsed;
    } else {
      delete coerced[key];
    }
  }

  for (const key of BOOLEAN_KEYS) {
    const value = coerced[key];
    if (value !== undefined && value !== '') {
      coerced[key] = value === true || value === 'true' || value === '1';
    } else {
      delete coerced[key];
    }
  }

  const instance = plainToInstance(EnvironmentVariables, coerced, {
    enableImplicitConversion: false,
    excludeExtraneousValues: false,
  });

  const errors = validateSync(instance, { skipMissingProperties: false, whitelist: false });
  if (errors.length > 0) {
    const details = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return instance;
}
