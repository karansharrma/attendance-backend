import { IsUUID } from 'class-validator';

export class AssignSiteDto {
  @IsUUID('4')
  siteId!: string;
}
