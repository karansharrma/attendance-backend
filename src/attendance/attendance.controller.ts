import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PaginatedResponse } from '../common/dto/pagination.dto';
import { AttendanceService, MyAttendanceRow } from './attendance.service';
import { MyAttendanceQueryDto } from './dto/my-attendance-query.dto';
import { SyncAttendanceDto, SyncResponse } from './dto/sync-attendance.dto';

@Controller('attendance')
@SkipThrottle({ auth: true })
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

  /**
   * The caller's own attendance history, newest first. Any authenticated role; always scoped
   * to the employee in the access token. The device uses it to restore history after a
   * reinstall.
   */
  @Get('me')
  myAttendance(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MyAttendanceQueryDto,
  ): Promise<PaginatedResponse<MyAttendanceRow>> {
    return this.attendanceService.findMine(user, query);
  }
}
