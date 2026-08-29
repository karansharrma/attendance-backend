import { IsISO8601, IsOptional } from 'class-validator';

export class AnalyticsQueryDto {
  /** Inclusive. Defaults to 30 days before `dateTo`. */
  @IsOptional()
  @IsISO8601({ strict: true })
  dateFrom?: string;

  /** Exclusive. Defaults to now. */
  @IsOptional()
  @IsISO8601({ strict: true })
  dateTo?: string;
}
