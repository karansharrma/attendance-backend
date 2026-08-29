import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PaginatedResponse, paginate } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { ListEmployeesQueryDto } from './dto/list-employees.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';

export const BCRYPT_ROUNDS = 10;

/** Site as the device caches it. */
export interface SiteSummary {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

/** Shape returned by GET /employees/:id. `faceEmbedding` is present for the owner only. */
export interface EmployeeSyncPayload {
  id: string;
  name: string;
  email: string;
  role: Role;
  isUnrestricted: boolean;
  embeddingModelVersion: string | null;
  /** Base64 of the raw little-endian float32 vector, or null when not enrolled. */
  faceEmbedding?: string | null;
  sites: SiteSummary[];
  createdAt: Date;
}

export type EmployeeSummary = Omit<EmployeeSyncPayload, 'faceEmbedding'> & {
  /** Whether an embedding exists, without revealing it. */
  isEnrolled: boolean;
};

const EMPLOYEE_WITH_SITES = {
  sites: { include: { site: true } },
} satisfies Prisma.EmployeeInclude;

type EmployeeWithSites = Prisma.EmployeeGetPayload<{ include: typeof EMPLOYEE_WITH_SITES }>;

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The payload the device pulls on first login and on every re-sync.
   *
   * The face embedding is returned **only** when the caller is the employee it belongs to.
   * An admin reading this endpoint gets everything except the bytes -- there is no
   * operational reason for an admin to hold another person's biometric template, and every
   * read of one is logged.
   */
  async findSyncPayload(
    employeeId: string,
    requester: AuthenticatedUser,
  ): Promise<EmployeeSyncPayload> {
    const isSelf = requester.sub === employeeId;
    if (!isSelf && requester.role !== Role.ADMIN) {
      throw new ForbiddenException('You may only read your own employee record');
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      include: EMPLOYEE_WITH_SITES,
    });
    if (!employee) throw new NotFoundException(`Employee ${employeeId} not found`);

    const payload = this.toSyncPayload(employee, isSelf);

    if (isSelf && employee.faceEmbedding) {
      this.logger.log(
        `Face embedding released to owner employeeId=${employeeId} ` +
          `modelVersion=${employee.embeddingModelVersion ?? 'unknown'} ` +
          `bytes=${employee.faceEmbedding.length}`,
      );
    } else if (!isSelf) {
      this.logger.log(`Employee ${employeeId} read by admin ${requester.sub}; embedding withheld`);
    }

    return payload;
  }

  async list(query: ListEmployeesQueryDto): Promise<PaginatedResponse<EmployeeSummary>> {
    const where: Prisma.EmployeeWhereInput = {
      ...(query.role ? { role: query.role } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
              { email: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.employee.findMany({
        where,
        include: EMPLOYEE_WITH_SITES,
        orderBy: { name: 'asc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.employee.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toSummary(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async create(dto: CreateEmployeeDto): Promise<EmployeeSummary> {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const employee = await this.prisma.employee.create({
      data: {
        name: dto.name,
        email: dto.email,
        passwordHash,
        role: dto.role ?? Role.EMPLOYEE,
        isUnrestricted: dto.isUnrestricted ?? false,
        ...(dto.siteIds?.length
          ? { sites: { create: dto.siteIds.map((siteId) => ({ siteId })) } }
          : {}),
      },
      include: EMPLOYEE_WITH_SITES,
    });

    this.logger.log(`Created employee ${employee.id} (${employee.role})`);
    return this.toSummary(employee);
  }

  async update(employeeId: string, dto: UpdateEmployeeDto): Promise<EmployeeSummary> {
    await this.assertExists(employeeId);

    const employee = await this.prisma.employee.update({
      where: { id: employeeId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
        ...(dto.role !== undefined ? { role: dto.role } : {}),
        ...(dto.isUnrestricted !== undefined ? { isUnrestricted: dto.isUnrestricted } : {}),
        ...(dto.password !== undefined
          ? { passwordHash: await bcrypt.hash(dto.password, BCRYPT_ROUNDS) }
          : {}),
      },
      include: EMPLOYEE_WITH_SITES,
    });

    this.logger.log(`Updated employee ${employeeId}`);
    return this.toSummary(employee);
  }

  async remove(employeeId: string): Promise<{ id: string; deleted: true }> {
    await this.assertExists(employeeId);
    await this.prisma.employee.delete({ where: { id: employeeId } });
    this.logger.warn(`Deleted employee ${employeeId} and all of their attendance records`);
    return { id: employeeId, deleted: true };
  }

  async assertExists(employeeId: string): Promise<void> {
    const count = await this.prisma.employee.count({ where: { id: employeeId } });
    if (count === 0) throw new NotFoundException(`Employee ${employeeId} not found`);
  }

  private toSyncPayload(
    employee: EmployeeWithSites,
    includeEmbedding: boolean,
  ): EmployeeSyncPayload {
    const base: EmployeeSyncPayload = {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      role: employee.role,
      isUnrestricted: employee.isUnrestricted,
      embeddingModelVersion: employee.embeddingModelVersion,
      sites: employee.sites.map(({ site }) => ({
        id: site.id,
        name: site.name,
        latitude: site.latitude,
        longitude: site.longitude,
        radiusMeters: site.radiusMeters,
      })),
      createdAt: employee.createdAt,
    };

    if (!includeEmbedding) return base;

    return {
      ...base,
      faceEmbedding: employee.faceEmbedding
        ? Buffer.from(employee.faceEmbedding).toString('base64')
        : null,
    };
  }

  private toSummary(employee: EmployeeWithSites): EmployeeSummary {
    const { faceEmbedding, ...rest } = this.toSyncPayload(employee, false);
    void faceEmbedding;
    return { ...rest, isEnrolled: employee.faceEmbedding !== null };
  }
}
