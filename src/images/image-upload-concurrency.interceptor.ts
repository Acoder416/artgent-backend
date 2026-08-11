import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable, finalize } from 'rxjs';

@Injectable()
export class ImageUploadConcurrencyInterceptor implements NestInterceptor {
  private readonly maxConcurrent: number;
  private active = 0;

  constructor(@Optional() configService?: ConfigService) {
    const configured = Number(
      configService?.get('IMAGE_UPLOAD_CONCURRENCY', 3) ?? 3,
    );
    this.maxConcurrent =
      Number.isInteger(configured) && configured >= 1 && configured <= 10
        ? configured
        : 3;
  }

  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    if (this.active >= this.maxConcurrent) {
      throw new ServiceUnavailableException(
        'Too many image upload requests are already in progress',
      );
    }
    this.active += 1;
    try {
      return next.handle().pipe(
        finalize(() => {
          this.active = Math.max(0, this.active - 1);
        }),
      );
    } catch (error: unknown) {
      this.active = Math.max(0, this.active - 1);
      throw error;
    }
  }
}
