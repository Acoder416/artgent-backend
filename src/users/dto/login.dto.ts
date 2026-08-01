import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';
import { normalizeEmailDomain } from './auth-input';

export class LoginDto {
  @Transform(({ value }) => normalizeEmailDomain(value))
  @IsString()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}
