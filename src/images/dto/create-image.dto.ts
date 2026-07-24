import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class CreateImageDto {
  @IsString()
  prompt: string;

  @IsOptional()
  @IsString()
  model = 'gpt-image-2';

  @IsOptional()
  @IsString()
  template = 'custom';

  @IsOptional()
  @IsIn(['1:1', '4:5', '3:4', '2:3', '3:2', '16:9', '9:16'])
  aspectRatio = '1:1';

  @IsOptional()
  @IsIn(['1K', '2K', '4K'])
  resolution = '1K';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  quantity = 1;

  @IsOptional()
  @IsString()
  size?: string;

  @IsOptional()
  @IsString()
  referenceImageUrl?: string;

  @IsOptional()
  @IsString()
  sourceImageUrl?: string;
}
