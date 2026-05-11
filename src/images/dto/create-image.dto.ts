import { IsString, IsOptional, IsIn } from 'class-validator';

export class CreateImageDto {
  @IsString()
  prompt: string;

  @IsOptional()
  @IsString()
  @IsIn(['gpt-image-1', 'dall-e-3'])
  model?: string = 'gpt-image-1';
}
