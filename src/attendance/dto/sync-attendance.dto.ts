import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { AttendanceStatus } from '@prisma/client';

/**
 * One punch-in as the device recorded it.
 *
 * Field names mirror the Room entity exactly so the mobile sync worker can serialise its
 * local row with no translation step.
 */
export class SyncAttendanceRecordDto {
  /**
   * Client-generated UUID. This is the idempotency key: the sync worker retries on network
   * failure, and the same id must land on the same row every time.
   */
  @IsUUID('4', { message: 'id must be a client-generated UUID v4' })
  id!: string;

  /**
   * Optional and advisory. The server always uses the employee id from the access token, and
   * rejects the whole batch if this disagrees -- a device must never be able to file
   * attendance under somebody else's name.
   */
  @IsOptional()
  @IsUUID('4')
  employeeId?: string;

  @IsISO8601({ strict: true }, { message: 'timestamp must be an ISO-8601 datetime' })
  timestamp!: string;

  @Type(() => Number)
  @IsLatitude()
  latitude!: number;

  @Type(() => Number)
  @IsLongitude()
  longitude!: number;

  /**
   * The geofence the device matched, if any. Intentionally not a foreign key: a record must
   * stay readable after the site it references has been deleted.
   */
  @IsOptional()
  @IsUUID('4')
  matchedSiteId?: string | null;

  /** Cosine similarity from the on-device match, in [0, 1]. */
  @Type(() => Number)
  // Model scores commonly retain more than six decimal places. Prisma stores this as a
  // DOUBLE PRECISION value, so do not reject an otherwise valid confidence solely because
  // the device did not round it before syncing.
  @IsNumber()
  @Min(0)
  @Max(1)
  faceMatchConfidence!: number;

  @IsEnum(AttendanceStatus)
  status!: AttendanceStatus;

  @IsBoolean()
  isMockLocation!: boolean;
}

export class SyncAttendanceDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'records must contain at least one attendance record' })
  @ArrayMaxSize(200, { message: 'records may not exceed 200 per request' })
  @ValidateNested({ each: true })
  @Type(() => SyncAttendanceRecordDto)
  records!: SyncAttendanceRecordDto[];
}

export type SyncOutcome = 'created' | 'updated' | 'unchanged' | 'rejected';

export interface SyncRecordResult {
  id: string;
  outcome: SyncOutcome;
  /** Present on `rejected`, and on accepted records that carried something worth flagging. */
  message?: string;
}

export interface SyncResponse {
  accepted: number;
  rejected: number;
  results: SyncRecordResult[];
  serverTime: string;
}
