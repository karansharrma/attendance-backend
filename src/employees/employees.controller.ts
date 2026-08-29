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
import { Role } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { PaginatedResponse } from '../common/dto/pagination.dto';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { ListEmployeesQueryDto } from './dto/list-employees.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { EmployeeSummary, EmployeeSyncPayload, EmployeesService } from './employees.service';

@Controller('employees')
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Roles(Role.ADMIN)
  @Get()
  list(@Query() query: ListEmployeesQueryDto): Promise<PaginatedResponse<EmployeeSummary>> {
    return this.employeesService.list(query);
  }

  /**
   * The device's full sync payload. Self-or-admin is enforced inside the service, which is
   * also where the face-embedding scoping and its audit log live.
   */
  @Get(':id')
  findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<EmployeeSyncPayload> {
    return this.employeesService.findSyncPayload(id, user);
  }

  @Roles(Role.ADMIN)
  @Post()
  create(@Body() dto: CreateEmployeeDto): Promise<EmployeeSummary> {
    return this.employeesService.create(dto);
  }

  @Roles(Role.ADMIN)
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateEmployeeDto,
  ): Promise<EmployeeSummary> {
    return this.employeesService.update(id, dto);
  }

  @Roles(Role.ADMIN)
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.employeesService.remove(id);
  }
}
