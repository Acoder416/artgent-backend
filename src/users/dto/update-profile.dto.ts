import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateProfileDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(24)
  @Matches(/^[A-Za-z0-9_\u3400-\u4DBF\u4E00-\u9FFF\u{20000}-\u{2EBEF}]+$/u, {
    message: '用户名仅支持中文、英文、数字与下划线',
  })
  username: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  removeAvatar?: boolean;
}
