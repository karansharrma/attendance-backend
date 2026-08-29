import { IsBase64, IsString, IsUUID, MaxLength, MinLength, Validate } from 'class-validator';
import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * The embedding is a raw float32 vector, so its byte length must be a multiple of 4.
 * Catching that here turns a corrupt upload into a clear 400 instead of a device that
 * silently fails every match afterwards.
 */
@ValidatorConstraint({ name: 'isFloat32Buffer', async: false })
export class IsFloat32BufferConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const byteLength = Buffer.from(value, 'base64').length;
    return byteLength > 0 && byteLength % 4 === 0 && byteLength <= 16 * 1024;
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must decode to a non-empty float32 buffer (byte length a multiple of 4, at most 16 KiB)`;
  }
}

export class CreateEnrollmentDto {
  @IsUUID('4')
  employeeId!: string;

  /**
   * Base64 of the L2-normalised embedding, little-endian float32 -- byte-identical to the
   * BLOB the device stores in Room, so it round-trips with no re-encoding.
   */
  @IsString()
  @IsBase64()
  @Validate(IsFloat32BufferConstraint)
  embedding!: string;

  /**
   * Which model produced it. Embeddings from different models are not comparable, and the
   * device refuses to match across a version change rather than returning nonsense.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  embeddingModelVersion!: string;
}
