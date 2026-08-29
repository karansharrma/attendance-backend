import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ReviewStatus } from '@prisma/client';

export class ReviewAttendanceDto {
  /**
   * Only the two terminal decisions are accepted. Moving a record back to PENDING would
   * erase who reviewed it, so re-opening is deliberately not an option here.
   */
  @IsIn([ReviewStatus.APPROVED, ReviewStatus.REJECTED], {
    message: 'reviewStatus must be APPROVED or REJECTED',
  })
  reviewStatus!: typeof ReviewStatus.APPROVED | typeof ReviewStatus.REJECTED;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
