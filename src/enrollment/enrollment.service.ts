import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';

export interface EnrollmentResult {
  employeeId: string;
  embeddingModelVersion: string;
  embeddingBytes: number;
  dimensions: number;
  supersededPrevious: boolean;
  enrolledAt: string;
}

@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Replaces an employee's face template.
   *
   * There is exactly one embedding per employee by design: the device already averages its
   * multi-angle samples into a single centroid before uploading, so keeping a history here
   * would store biometric data nothing reads. The response deliberately echoes back only
   * metadata -- never the bytes, not even to the admin who just uploaded them.
   */
  async enroll(dto: CreateEnrollmentDto, actor: AuthenticatedUser): Promise<EnrollmentResult> {
    const existing = await this.prisma.employee.findUnique({
      where: { id: dto.employeeId },
      select: { id: true, faceEmbedding: true, embeddingModelVersion: true },
    });
    if (!existing) throw new NotFoundException(`Employee ${dto.employeeId} not found`);

    const buffer = Buffer.from(dto.embedding, 'base64');

    await this.prisma.employee.update({
      where: { id: dto.employeeId },
      data: {
        faceEmbedding: buffer,
        embeddingModelVersion: dto.embeddingModelVersion,
      },
    });

    const supersededPrevious = existing.faceEmbedding !== null;

    this.logger.log(
      `Enrollment written for employeeId=${dto.employeeId} by admin=${actor.sub} ` +
        `model=${dto.embeddingModelVersion} bytes=${buffer.length} ` +
        `superseded=${supersededPrevious}` +
        (supersededPrevious && existing.embeddingModelVersion !== dto.embeddingModelVersion
          ? ` previousModel=${existing.embeddingModelVersion}`
          : ''),
    );

    return {
      employeeId: dto.employeeId,
      embeddingModelVersion: dto.embeddingModelVersion,
      embeddingBytes: buffer.length,
      dimensions: buffer.length / Float32Array.BYTES_PER_ELEMENT,
      supersededPrevious,
      enrolledAt: new Date().toISOString(),
    };
  }

  /** Clears a template, e.g. before a re-enrollment on a new model version. */
  async revoke(
    employeeId: string,
    actor: AuthenticatedUser,
  ): Promise<{ employeeId: string; cleared: boolean }> {
    const existing = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { faceEmbedding: true },
    });
    if (!existing) throw new NotFoundException(`Employee ${employeeId} not found`);

    await this.prisma.employee.update({
      where: { id: employeeId },
      data: { faceEmbedding: null, embeddingModelVersion: null },
    });

    this.logger.warn(`Enrollment revoked for employeeId=${employeeId} by admin=${actor.sub}`);
    return { employeeId, cleared: existing.faceEmbedding !== null };
  }
}
