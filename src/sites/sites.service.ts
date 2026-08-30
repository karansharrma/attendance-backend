import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, Site } from '@prisma/client';
import { PaginatedResponse, paginate } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSiteDto } from './dto/create-site.dto';
import { ListSitesQueryDto } from './dto/list-sites.dto';
import { UpdateSiteDto } from './dto/update-site.dto';
import { NotificationsService } from '../notifications/notifications.service';

export interface SiteWithAssignmentCount extends Site {
  assignedEmployeeCount: number;
}

@Injectable()
export class SitesService {
  private readonly logger = new Logger(SitesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(query: ListSitesQueryDto): Promise<PaginatedResponse<SiteWithAssignmentCount>> {
    const where: Prisma.SiteWhereInput = query.search
      ? { name: { contains: query.search, mode: Prisma.QueryMode.insensitive } }
      : {};

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.site.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: query.skip,
        take: query.limit,
        include: { _count: { select: { employees: true } } },
      }),
      this.prisma.site.count({ where }),
    ]);

    const data = rows.map(({ _count, ...site }) => ({
      ...site,
      assignedEmployeeCount: _count.employees,
    }));

    return paginate(data, total, query.page, query.limit);
  }

  async findOne(siteId: string): Promise<SiteWithAssignmentCount> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      include: { _count: { select: { employees: true } } },
    });
    if (!site) throw new NotFoundException(`Site ${siteId} not found`);

    const { _count, ...rest } = site;
    return { ...rest, assignedEmployeeCount: _count.employees };
  }

  async create(dto: CreateSiteDto): Promise<Site> {
    const site = await this.prisma.site.create({ data: { ...dto } });
    this.logger.log(`Created site ${site.id} (${site.name}) r=${site.radiusMeters}m`);
    return site;
  }

  async update(siteId: string, dto: UpdateSiteDto): Promise<Site> {
    await this.assertExists(siteId);
    const site = await this.prisma.site.update({ where: { id: siteId }, data: { ...dto } });

    // Moving or resizing a geofence silently changes who is "on site" from now on, so it is
    // worth an explicit log line when reconciling a disputed attendance record later.
    this.logger.log(
      `Updated site ${siteId}: lat=${site.latitude} lng=${site.longitude} r=${site.radiusMeters}m`,
    );
    return site;
  }

  async remove(siteId: string): Promise<{ id: string; deleted: true }> {
    await this.assertExists(siteId);

    // Assignments cascade; historical attendance keeps its matchedSiteId as a bare string so
    // past records stay auditable even after the site itself is gone.
    await this.prisma.site.delete({ where: { id: siteId } });
    this.logger.warn(`Deleted site ${siteId} and every assignment referencing it`);
    return { id: siteId, deleted: true };
  }

  async assertExists(siteId: string): Promise<void> {
    const count = await this.prisma.site.count({ where: { id: siteId } });
    if (count === 0) throw new NotFoundException(`Site ${siteId} not found`);
  }

  /**
   * Idempotent assign: re-assigning an already-assigned site is a no-op rather than a 409,
   * because the admin UI can fire this from a checkbox that may already be checked.
   */
  async assignToEmployee(
    employeeId: string,
    siteId: string,
  ): Promise<{ employeeId: string; siteId: string; assigned: true }> {
    await this.assertExists(siteId);

    const existing = await this.prisma.employeeSite.findUnique({
      where: { employeeId_siteId: { employeeId, siteId } },
    });
    await this.prisma.employeeSite.upsert({
      where: { employeeId_siteId: { employeeId, siteId } },
      create: { employeeId, siteId },
      update: {},
    });

    if (!existing) {
      try {
        await this.notifications.notifyEmployeeOfSiteAssignment(employeeId, siteId);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown notification error';
        this.logger.error(`Assignment notification failed for employee ${employeeId}: ${message}`);
      }
    }

    this.logger.log(`Assigned site ${siteId} to employee ${employeeId}`);
    return { employeeId, siteId, assigned: true };
  }

  async unassignFromEmployee(
    employeeId: string,
    siteId: string,
  ): Promise<{ employeeId: string; siteId: string; assigned: false }> {
    const existing = await this.prisma.employeeSite.findUnique({
      where: { employeeId_siteId: { employeeId, siteId } },
    });
    if (!existing) {
      throw new NotFoundException(`Employee ${employeeId} is not assigned to site ${siteId}`);
    }

    await this.prisma.employeeSite.delete({
      where: { employeeId_siteId: { employeeId, siteId } },
    });

    const remaining = await this.prisma.employeeSite.count({ where: { employeeId } });
    if (remaining === 0) {
      // Worth flagging: with zero sites the device treats every punch-in as UNRESTRICTED.
      this.logger.warn(
        `Employee ${employeeId} now has no assigned sites and can punch in from anywhere`,
      );
    }

    this.logger.log(`Unassigned site ${siteId} from employee ${employeeId}`);
    return { employeeId, siteId, assigned: false };
  }
}
