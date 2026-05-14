import { IsString, IsOptional } from 'class-validator';

export class CreateImageDto {
  @IsString()
  prompt: string;

  @IsOptional()
  @IsString()
  model?: string = 'gpt-image-2';

  @IsOptional()
  @IsString()
  size?: string = '1024x1024';

  @IsOptional()
  @IsString()
  referenceImageUrl?: string;

  @IsOptional()
  @IsString()
  sourceImageUrl?: string;
}
