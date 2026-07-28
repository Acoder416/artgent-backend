import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AI_LINE_ID_PATTERN } from '../ai-line';

export class RewritePromptDto {
  @IsOptional()
  @Matches(AI_LINE_ID_PATTERN)
  lineId?: string;

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
