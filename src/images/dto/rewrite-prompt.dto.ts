import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RewritePromptDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(1000)
  brief: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  currentPrompt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  template?: string;
}
