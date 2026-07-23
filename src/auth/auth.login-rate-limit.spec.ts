import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('POST /auth/login rate limit', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 5 }])],
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            login: jest.fn().mockResolvedValue({ token: 'test-token' }),
          },
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects the sixth login attempt from one client within a minute', async () => {
    const server = app.getHttpServer();
    const credentials = {
      email: 'owner@example.com',
      password: 'valid-password',
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(server).post('/auth/login').send(credentials).expect(201);
    }

    await request(server).post('/auth/login').send(credentials).expect(429);
  });
});
