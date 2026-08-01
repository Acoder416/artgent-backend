import { Transform } from 'class-transformer';
import { IsString, IsEmail, MinLength, MaxLength } from 'class-validator';
import { normalizeEmailDomain, trimIdentity } from './auth-input';

export class CreateUserDto {
  @Transform(({ value }) => trimIdentity(value))
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  username: string;

  @Transform(({ value }) => normalizeEmailDomain(value))
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  @MaxLength(50)
  password: string;
}
