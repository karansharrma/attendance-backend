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
import { Role, Site } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { PaginatedResponse } from '../common/dto/pagination.dto';
import { CreateSiteDto } from './dto/create-site.dto';
import { ListSitesQueryDto } from './dto/list-sites.dto';
import { UpdateSiteDto } from './dto/update-site.dto';
import { SiteWithAssignmentCount, SitesService } from './sites.service';

/**
 * Site management is admin-only. Employees never call these: the sites they are assigned to
 * arrive inside their own sync payload from GET /employees/:id.
 */
@Roles(Role.ADMIN)
@Controller('admin/sites')
@SkipThrottle({ auth: true })
export class SitesController {
  constructor(private readonly sitesService: SitesService) {}

  @Get()
  list(@Query() query: ListSitesQueryDto): Promise<PaginatedResponse<SiteWithAssignmentCount>> {
    return this.sitesService.list(query);
  }

  @Get(':id')
  findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<SiteWithAssignmentCount> {
    return this.sitesService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateSiteDto): Promise<Site> {
    return this.sitesService.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateSiteDto,
  ): Promise<Site> {
    return this.sitesService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.sitesService.remove(id);
  }
}
