import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginThrottlerGuard } from './guards/login-throttler.guard';

describe('auth input normalization', () => {
  let app: INestApplication<App>;
  const authService = {
    login: jest.fn(),
    register: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    authService.register.mockResolvedValue({
      token: 'test-token',
      user: {
        id: 1,
        username: 'Creator',
        email: 'Creator@example.com',
      },
    });

    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
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

  it('normalizes registration identity fields without changing the password', async () => {
    const password = '  valid-password  ';

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        username: '  Creator  ',
        email: '  Creator@EXAMPLE.COM  ',
        password,
      })
      .expect(201);

    expect(authService.register).toHaveBeenCalledWith({
      username: 'Creator',
      email: 'Creator@example.com',
      password,
    });
  });

  it('normalizes login email without changing the password', async () => {
    const password = '  valid-password  ';
    authService.login.mockResolvedValue({ token: 'test-token' });

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: '  Creator@EXAMPLE.COM  ',
        password,
      })
      .expect(201);

    expect(authService.login).toHaveBeenCalledWith({
      email: 'Creator@example.com',
      password,
    });
  });
});
