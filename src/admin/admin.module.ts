import { Module } from '@nestjs/common';
import { EmployeesModule } from '../employees/employees.module';
import { SitesModule } from '../sites/sites.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [SitesModule, EmployeesModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
