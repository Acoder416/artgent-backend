import { IsString, IsOptional } from 'class-validator';

export class CreateImageDto {
  @IsString()
  prompt: string;

  @IsOptional()
  @IsString()
  model?: string = 'gpt-image-1';
}
