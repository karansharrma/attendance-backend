import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AttendanceStatus, PunchType, Prisma, ReviewStatus } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import { PaginatedResponse, paginate } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import { QueryAttendanceDto } from './dto/query-attendance.dto';
import { ReviewAttendanceDto } from './dto/review-attendance.dto';

export interface AttendanceRow {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeEmail: string;
  timestamp: Date;
  latitude: number;
  longitude: number;
  matchedSiteId: string | null;
  matchedSiteName: string | null;
  faceMatchConfidence: number;
  status: AttendanceStatus;
  isMockLocation: boolean;
  punchType: PunchType;
  pairedPunchId: string | null;
  shiftDurationMinutes: number | null;
  reviewStatus: ReviewStatus;
  reviewedByAdminId: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  createdAt: Date;
}

interface DailyTrendRow {
  date: string;
  total: number;
  flagged: number;
  late: number;
}

export interface AnalyticsSummary {
  range: { from: string; to: string; timezone: string };
  totals: {
    punchIns: number;
    punchOuts: number;
    activeEmployees: number;
    verified: number;
    flaggedOutsideGeofence: number;
    unrestricted: number;
    mockLocationAttempts: number;
    totalShiftHours: number;
    averageShiftMinutes: number;
  };
  review: { pending: number; approved: number; rejected: number };
  lateArrivals: { cutoffMinutesOfDay: number; cutoffLocalTime: string; count: number };
  dailyTrend: DailyTrendRow[];
}

type AttendanceRecordWithEmployee = Prisma.AttendanceRecordGetPayload<{
  include: { employee: { select: { name: true; email: true } } };
}>;

const DEFAULT_WINDOW_DAYS = 30;

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async queryAttendance(query: QueryAttendanceDto): Promise<PaginatedResponse<AttendanceRow>> {
    const where = this.buildWhere(query);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.attendanceRecord.findMany({
        where,
        include: { employee: { select: { name: true, email: true } } },
        orderBy: { [query.sortBy ?? 'timestamp']: query.sortOrder ?? 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.attendanceRecord.count({ where }),
    ]);

    // matchedSiteId is not a relation (records outlive the sites they reference), so site
    // names are resolved in one extra lookup rather than a join.
    const siteNames = await this.resolveSiteNames(rows.map((row) => row.matchedSiteId));

    const data = rows.map((row) => this.toRow(row, siteNames));

    return paginate(data, total, query.page, query.limit);
  }

  async review(
    recordId: string,
    dto: ReviewAttendanceDto,
    admin: AuthenticatedUser,
  ): Promise<AttendanceRow> {
    const existing = await this.prisma.attendanceRecord.findUnique({ where: { id: recordId } });
    if (!existing) throw new NotFoundException(`Attendance record ${recordId} not found`);

    const updated = await this.prisma.attendanceRecord.update({
      where: { id: recordId },
      data: {
        reviewStatus: dto.reviewStatus,
        reviewedByAdminId: admin.sub,
        reviewedAt: new Date(),
        reviewNote: dto.note ?? null,
      },
      include: { employee: { select: { name: true, email: true } } },
    });

    this.logger.log(
      `Record ${recordId} (${existing.status}) reviewed as ${dto.reviewStatus} by admin ${admin.sub}` +
        (existing.reviewStatus !== ReviewStatus.PENDING
          ? ` [previously ${existing.reviewStatus}]`
          : ''),
    );

    const siteNames = await this.resolveSiteNames([updated.matchedSiteId]);
    return this.toRow(updated, siteNames);
  }

  /**
   * Trends, late arrivals and flagged counts for the dashboard.
   *
   * "Late" is a wall-clock question, so the day boundary and the cut-off comparison both run
   * in a configured reporting timezone rather than UTC; a 09:15 cut-off evaluated in UTC
   * would be wrong for every deployment that is not on GMT.
   */
  async analyticsSummary(query: AnalyticsQueryDto): Promise<AnalyticsSummary> {
    const { from, to } = this.resolveRange(query);
    const timezone = this.config.get<string>('REPORTING_TIMEZONE', 'UTC');
    const cutoffMinutes = this.config.get<number>('LATE_ARRIVAL_CUTOFF_MINUTES', 555);

    const where: Prisma.AttendanceRecordWhereInput = { timestamp: { gte: from, lt: to } };

    const [byStatus, byReview, byPunchType, mockCount, distinctEmployees, dailyTrend, lateCount, shiftStats] =
      await Promise.all([
        this.prisma.attendanceRecord.groupBy({ by: ['status'], where, _count: { _all: true } }),
        this.prisma.attendanceRecord.groupBy({
          by: ['reviewStatus'],
          where,
          _count: { _all: true },
        }),
        this.prisma.attendanceRecord.groupBy({ by: ['punchType'], where, _count: { _all: true } }),
        this.prisma.attendanceRecord.count({ where: { ...where, isMockLocation: true } }),
        this.prisma.attendanceRecord.findMany({
          where,
          distinct: ['employeeId'],
          select: { employeeId: true },
        }),
        this.dailyTrend(from, to, timezone, cutoffMinutes),
        this.lateArrivalCount(from, to, timezone, cutoffMinutes),
        this.shiftStatistics(where),
      ]);

    const statusCount = (status: AttendanceStatus): number =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0;
    const reviewCount = (status: ReviewStatus): number =>
      byReview.find((row) => row.reviewStatus === status)?._count._all ?? 0;
    const punchTypeCount = (type: PunchType): number =>
      byPunchType.find((row) => row.punchType === type)?._count._all ?? 0;

    return {
      range: { from: from.toISOString(), to: to.toISOString(), timezone },
      totals: {
        punchIns: punchTypeCount(PunchType.IN),
        punchOuts: punchTypeCount(PunchType.OUT),
        activeEmployees: distinctEmployees.length,
        verified: statusCount(AttendanceStatus.VERIFIED),
        flaggedOutsideGeofence: statusCount(AttendanceStatus.FLAGGED_OUTSIDE_GEOFENCE),
        unrestricted: statusCount(AttendanceStatus.UNRESTRICTED),
        mockLocationAttempts: mockCount,
        totalShiftHours: shiftStats.totalHours,
        averageShiftMinutes: shiftStats.averageMinutes,
      },
      review: {
        pending: reviewCount(ReviewStatus.PENDING),
        approved: reviewCount(ReviewStatus.APPROVED),
        rejected: reviewCount(ReviewStatus.REJECTED),
      },
      lateArrivals: {
        cutoffMinutesOfDay: cutoffMinutes,
        cutoffLocalTime: formatMinutesOfDay(cutoffMinutes),
        count: lateCount,
      },
      dailyTrend,
    };
  }

  private toRow(row: AttendanceRecordWithEmployee, siteNames: Map<string, string>): AttendanceRow {
    return {
      id: row.id,
      employeeId: row.employeeId,
      employeeName: row.employee.name,
      employeeEmail: row.employee.email,
      timestamp: row.timestamp,
      latitude: row.latitude,
      longitude: row.longitude,
      matchedSiteId: row.matchedSiteId,
      matchedSiteName: row.matchedSiteId ? (siteNames.get(row.matchedSiteId) ?? null) : null,
      faceMatchConfidence: row.faceMatchConfidence,
      status: row.status,
      isMockLocation: row.isMockLocation,
      punchType: row.punchType,
      pairedPunchId: row.pairedPunchId,
      shiftDurationMinutes: row.shiftDurationMinutes,
      reviewStatus: row.reviewStatus,
      reviewedByAdminId: row.reviewedByAdminId,
      reviewedAt: row.reviewedAt,
      reviewNote: row.reviewNote,
      createdAt: row.createdAt,
    };
  }

  private buildWhere(query: QueryAttendanceDto): Prisma.AttendanceRecordWhereInput {
    const timestamp: Prisma.DateTimeFilter = {};
    if (query.dateFrom) timestamp.gte = new Date(query.dateFrom);
    if (query.dateTo) timestamp.lt = new Date(query.dateTo);

    if (timestamp.gte && timestamp.lt && timestamp.gte >= timestamp.lt) {
      throw new BadRequestException('dateFrom must be earlier than dateTo');
    }

    return {
      ...(query.status ? { status: query.status } : {}),
      ...(query.reviewStatus ? { reviewStatus: query.reviewStatus } : {}),
      ...(query.punchType ? { punchType: query.punchType } : {}),
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(timestamp.gte || timestamp.lt ? { timestamp } : {}),
    };
  }

  private async resolveSiteNames(siteIds: (string | null)[]): Promise<Map<string, string>> {
    const ids = Array.from(new Set(siteIds.filter((id): id is string => Boolean(id))));
    if (ids.length === 0) return new Map();

    const sites = await this.prisma.site.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(sites.map((site) => [site.id, site.name]));
  }

  private resolveRange(query: AnalyticsQueryDto): { from: Date; to: Date } {
    const to = query.dateTo ? new Date(query.dateTo) : new Date();
    const from = query.dateFrom
      ? new Date(query.dateFrom)
      : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    if (from >= to) throw new BadRequestException('dateFrom must be earlier than dateTo');
    return { from, to };
  }

  /**
   * Prisma maps DateTime to `timestamp(3)` without a zone, holding UTC wall-clock values, so
   * the conversion is two steps: reinterpret the naive value as UTC, then shift it into the
   * reporting zone. A single `AT TIME ZONE ${tz}` on a naive column converts the wrong way
   * round and would silently skew every day boundary and late-arrival comparison.
   */
  private async dailyTrend(
    from: Date,
    to: Date,
    timezone: string,
    cutoffMinutes: number,
  ): Promise<DailyTrendRow[]> {
    const rows = await this.prisma.$queryRaw<
      { date: string; total: bigint; flagged: bigint; late: bigint }[]
    >`
      SELECT
        to_char((("timestamp" AT TIME ZONE 'UTC') AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS date,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'FLAGGED_OUTSIDE_GEOFENCE') AS flagged,
        COUNT(*) FILTER (
          WHERE EXTRACT(HOUR FROM (("timestamp" AT TIME ZONE 'UTC') AT TIME ZONE ${timezone})) * 60
              + EXTRACT(MINUTE FROM (("timestamp" AT TIME ZONE 'UTC') AT TIME ZONE ${timezone}))
              > ${cutoffMinutes}
        ) AS late
      FROM attendance_records
      WHERE "timestamp" >= ${from} AND "timestamp" < ${to}
      GROUP BY 1
      ORDER BY 1 ASC
    `;

    return rows.map((row) => ({
      date: row.date,
      total: Number(row.total),
      flagged: Number(row.flagged),
      late: Number(row.late),
    }));
  }

  private async lateArrivalCount(
    from: Date,
    to: Date,
    timezone: string,
    cutoffMinutes: number,
  ): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count
      FROM attendance_records
      WHERE "timestamp" >= ${from} AND "timestamp" < ${to}
        AND EXTRACT(HOUR FROM (("timestamp" AT TIME ZONE 'UTC') AT TIME ZONE ${timezone})) * 60
          + EXTRACT(MINUTE FROM (("timestamp" AT TIME ZONE 'UTC') AT TIME ZONE ${timezone}))
          > ${cutoffMinutes}
    `;
    return Number(rows[0]?.count ?? 0);
  }

  private async shiftStatistics(where: Prisma.AttendanceRecordWhereInput): Promise<{
    totalHours: number;
    averageMinutes: number;
  }> {
    const result = await this.prisma.attendanceRecord.aggregate({
      where: {
        ...where,
        punchType: PunchType.OUT,
        shiftDurationMinutes: { not: null },
      },
      _count: { _all: true },
      _sum: { shiftDurationMinutes: true },
    });

    const totalMinutes = result._sum.shiftDurationMinutes ?? 0;
    const count = result._count._all;

    return {
      totalHours: Number((totalMinutes / 60).toFixed(2)),
      averageMinutes: count > 0 ? Math.round(totalMinutes / count) : 0,
    };
  }
}

function formatMinutesOfDay(minutes: number): string {
  const hours = Math.floor(minutes / 60)
    .toString()
    .padStart(2, '0');
  const mins = (minutes % 60).toString().padStart(2, '0');
  return `${hours}:${mins}`;
}
