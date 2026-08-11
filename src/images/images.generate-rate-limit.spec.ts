import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AiService } from './ai.service';
import { ImageGenerationThrottlerGuard } from './image-generation-throttler.guard';
import { ImageUploadConcurrencyInterceptor } from './image-upload-concurrency.interceptor';
import { ImagesController } from './images.controller';
import { ImagesService } from './images.service';

describe('POST /images/generate rate limit', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [ImagesController],
      providers: [
        ConfigService,
        ImageGenerationThrottlerGuard,
        ImageUploadConcurrencyInterceptor,
        {
          provide: ImagesService,
          useValue: {
            generateBatch: jest.fn().mockResolvedValue({
              images: [],
              requestId: 'request-1',
              chargedCredits: 0,
            }),
          },
        },
        {
          provide: AiService,
          useValue: {},
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => {
            getRequest: () => {
              headers: Record<string, string>;
              user?: { id: number };
            };
          };
        }) => {
          const incoming = context.switchToHttp().getRequest();
          incoming.user = { id: Number(incoming.headers['x-test-user-id']) };
          return true;
        },
      })
      .compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('limits repeated uploads per authenticated user without sharing counters', async () => {
    const server = app.getHttpServer();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(server)
        .post('/images/generate')
        .set('x-test-user-id', '7')
        .field('prompt', 'A product photograph')
        .expect(201);
    }

    await request(server)
      .post('/images/generate')
      .set('x-test-user-id', '8')
      .field('prompt', 'A different product photograph')
      .expect(201);
    await request(server)
      .post('/images/generate')
      .set('x-test-user-id', '7')
      .field('prompt', 'One request too many')
      .expect(429);
  });
});
