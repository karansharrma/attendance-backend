import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { EnrollmentResult, EnrollmentService } from './enrollment.service';

@Roles(Role.ADMIN)
@Controller('enrollment')
export class EnrollmentController {
  constructor(private readonly enrollmentService: EnrollmentService) {}

  /** Uploads a face template for an employee, superseding any previous one. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  enroll(
    @Body() dto: CreateEnrollmentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<EnrollmentResult> {
    return this.enrollmentService.enroll(dto, actor);
  }

  @Delete(':employeeId')
  @HttpCode(HttpStatus.OK)
  revoke(
    @Param('employeeId', new ParseUUIDPipe({ version: '4' })) employeeId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.enrollmentService.revoke(employeeId, actor);
  }
}
