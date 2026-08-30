import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { PaginatedResponse } from '../common/dto/pagination.dto';
import { EmployeesService } from '../employees/employees.service';
import { SitesService } from '../sites/sites.service';
import { AdminService, AnalyticsSummary, AttendanceRow } from './admin.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import { AssignSiteDto } from './dto/assign-site.dto';
import { QueryAttendanceDto } from './dto/query-attendance.dto';
import { ReviewAttendanceDto } from './dto/review-attendance.dto';

/** Every route here is gated by the class-level @Roles(ADMIN) plus the global RolesGuard. */
@Roles(Role.ADMIN)
@Controller('admin')
@SkipThrottle({ auth: true })
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly sitesService: SitesService,
    private readonly employeesService: EmployeesService,
  ) {}

  @Get('attendance')
  queryAttendance(@Query() query: QueryAttendanceDto): Promise<PaginatedResponse<AttendanceRow>> {
    return this.adminService.queryAttendance(query);
  }

  @Patch('attendance/:id/review')
  review(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ReviewAttendanceDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AttendanceRow> {
    return this.adminService.review(id, dto, admin);
  }

  @Post('employees/:id/sites')
  @HttpCode(HttpStatus.OK)
  async assignSite(
    @Param('id', new ParseUUIDPipe({ version: '4' })) employeeId: string,
    @Body() dto: AssignSiteDto,
  ) {
    await this.employeesService.assertExists(employeeId);
    return this.sitesService.assignToEmployee(employeeId, dto.siteId);
  }

  @Delete('employees/:id/sites/:siteId')
  @HttpCode(HttpStatus.OK)
  async unassignSite(
    @Param('id', new ParseUUIDPipe({ version: '4' })) employeeId: string,
    @Param('siteId', new ParseUUIDPipe({ version: '4' })) siteId: string,
  ) {
    await this.employeesService.assertExists(employeeId);
    return this.sitesService.unassignFromEmployee(employeeId, siteId);
  }

  @Get('analytics/summary')
  analytics(@Query() query: AnalyticsQueryDto): Promise<AnalyticsSummary> {
    return this.adminService.analyticsSummary(query);
  }
}
