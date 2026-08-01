import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { UsersService } from '../users/users.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginThrottlerGuard } from './guards/login-throttler.guard';

describe('POST /auth/login remember me', () => {
  let app: INestApplication<App>;
  const user = {
    id: 1,
    username: 'Creator',
    email: 'Creator@example.com',
    passwordHash: 'stored-hash',
  };
  const usersService = {
    create: jest.fn(),
    findByEmail: jest.fn().mockResolvedValue(user),
    validatePassword: jest.fn().mockResolvedValue(true),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: 'remember-login-test-secret-at-least-32-characters',
          signOptions: { expiresIn: '1h' },
        }),
      ],
      controllers: [AuthController],
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
      ],
    })
      .overrideGuard(LoginThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('issues a seven-day token when remember me is selected', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'Creator@example.com',
        password: 'valid-password',
        rememberMe: true,
      })
      .expect(201);

    const body: unknown = response.body;
    if (
      typeof body !== 'object' ||
      body === null ||
      !('token' in body) ||
      typeof body.token !== 'string'
    ) {
      throw new Error('Expected the login response to contain a token');
    }
    const payload = app.get(JwtService).decode<{
      exp: number;
      iat: number;
    }>(body.token);

    expect(payload.exp - payload.iat).toBe(7 * 24 * 60 * 60);
  });
});
