import { Transform } from 'class-transformer';
import { IsEnum, IsISO8601, IsIn, IsOptional, IsUUID } from 'class-validator';
import { AttendanceStatus, ReviewStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class QueryAttendanceDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(AttendanceStatus)
  status?: AttendanceStatus;

  @IsOptional()
  @IsEnum(ReviewStatus)
  reviewStatus?: ReviewStatus;

  @IsOptional()
  @IsUUID('4')
  employeeId?: string;

  /** Inclusive lower bound on `timestamp`. */
  @IsOptional()
  @IsISO8601({ strict: true })
  dateFrom?: string;

  /** Exclusive upper bound on `timestamp`. */
  @IsOptional()
  @IsISO8601({ strict: true })
  dateTo?: string;

  @IsOptional()
  @IsIn(['timestamp', 'createdAt', 'faceMatchConfidence'])
  sortBy?: 'timestamp' | 'createdAt' | 'faceMatchConfidence' = 'timestamp';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  sortOrder?: 'asc' | 'desc' = 'desc';
}
