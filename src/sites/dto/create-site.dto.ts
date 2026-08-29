import { Type } from 'class-transformer';
import {
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsString,
  Max,
  Min,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateSiteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @Type(() => Number)
  @IsLatitude()
  latitude!: number;

  @Type(() => Number)
  @IsLongitude()
  longitude!: number;

  /**
   * Lower bound is not arbitrary: the device refuses GPS fixes worse than 30 m accuracy, so
   * a radius much below that would reject legitimate punch-ins on a bad-signal day.
   */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(25, { message: 'radiusMeters below 25 is smaller than achievable GPS accuracy' })
  @Max(50000)
  radiusMeters!: number;
}
