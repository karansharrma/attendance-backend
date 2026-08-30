import { IsBoolean } from 'class-validator';

export class UpdateNotificationPreferencesDto {
  /** Whether this admin wants alerts when an employee punches out. */
  @IsBoolean()
  punchOutNotificationsEnabled!: boolean;
}
