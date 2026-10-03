import { IsISO8601, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

/** Query for GET /attendance/me: the caller's own history, newest first. */
export class MyAttendanceQueryDto extends PaginationQueryDto {
  /** Inclusive lower bound on `timestamp`. */
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  /** Exclusive upper bound on `timestamp`. */
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}
