import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { AI_LINE_ID_PATTERN } from '../ai-line';
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_QUALITIES,
  IMAGE_RESOLUTIONS,
  type ImageAspectRatio,
  type ImageQuality,
  type ImageResolution,
} from '../image-parameters';

export class CreateImageDto {
  @IsString()
  prompt: string;

  @IsOptional()
  @IsString()
  model = 'gpt-image-2';

  @IsOptional()
  @Matches(AI_LINE_ID_PATTERN)
  lineId?: string;

  @IsOptional()
  @IsString()
  template = 'custom';

  @IsOptional()
  @IsIn([...IMAGE_ASPECT_RATIOS])
  aspectRatio?: ImageAspectRatio;

  @IsOptional()
  @IsIn([...IMAGE_ASPECT_RATIOS])
  aspect_ratio?: ImageAspectRatio;

  @IsOptional()
  @IsIn([...IMAGE_RESOLUTIONS])
  resolution?: ImageResolution;

  @IsOptional()
  @IsIn([...IMAGE_QUALITIES])
  quality?: ImageQuality;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  quantity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  n?: number;

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
