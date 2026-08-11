import {
  CallHandler,
  ExecutionContext,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NEVER, lastValueFrom, of } from 'rxjs';
import { ImageUploadConcurrencyInterceptor } from './image-upload-concurrency.interceptor';

const context = {} as ExecutionContext;

describe('ImageUploadConcurrencyInterceptor', () => {
  it('caps in-flight multipart requests and releases slots on unsubscribe', async () => {
    const interceptor = new ImageUploadConcurrencyInterceptor(
      new ConfigService({ IMAGE_UPLOAD_CONCURRENCY: 2 }),
    );
    const neverHandler = { handle: () => NEVER } as CallHandler;
    const first = interceptor.intercept(context, neverHandler).subscribe();
    const second = interceptor.intercept(context, neverHandler).subscribe();

    expect(() => interceptor.intercept(context, neverHandler)).toThrow(
      ServiceUnavailableException,
    );

    first.unsubscribe();
    await expect(
      lastValueFrom(
        interceptor.intercept(context, {
          handle: () => of('accepted'),
        } as CallHandler),
      ),
    ).resolves.toBe('accepted');
    second.unsubscribe();
  });
});
