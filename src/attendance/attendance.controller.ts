import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AttendanceService } from './attendance.service';
import { SyncAttendanceDto, SyncResponse } from './dto/sync-attendance.dto';

@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  /**
   * 200, not 201: the call is idempotent, and a retry that finds everything already stored
   * is just as successful as the first attempt that stored it.
   */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  sync(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SyncAttendanceDto,
  ): Promise<SyncResponse> {
    return this.attendanceService.sync(user, dto);
  }
}
