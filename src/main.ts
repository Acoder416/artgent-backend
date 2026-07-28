import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ensureDatabaseExists } from './bootstrap/database';
import {
  initializeEnvironment,
  resolveEnvironment,
} from './bootstrap/environment';
import {
  assertPortAvailable,
  parseAllowedOrigins,
  parsePort,
  PortInUseError,
} from './bootstrap/http';
import { UsersService } from './users/users.service';

async function bootstrap() {
  const environment = resolveEnvironment(process.argv.slice(2), process.env);
  process.env.NODE_ENV = environment;
  const config = initializeEnvironment({
    environment,
    projectDir: process.cwd(),
    environmentVariables: process.env,
  });
  Object.assign(process.env, config);

  const port = parsePort(config.PORT || '3001');
  await assertPortAvailable(port);

  await ensureDatabaseExists(config);
  console.log(`[DB] Database "${config.DB_DATABASE || 'artgen'}" ensured`);

  // Load AppModule only after the selected environment is fully initialized.
  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const usersService = app.get(UsersService);
  const allowedOrigins = parseAllowedOrigins(config.CORS_ALLOWED_ORIGINS);

  await usersService.ensureAdminUser({
    username: configService.getOrThrow<string>('ADMIN_USERNAME'),
    email: configService.getOrThrow<string>('ADMIN_EMAIL'),
    password: configService.getOrThrow<string>('ADMIN_PASSWORD'),
  });

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('api');

  await app.listen(port);
  console.log(
    `Application is running in ${environment} mode on: http://localhost:${port}`,
  );
}

void bootstrap().catch((error: unknown) => {
  if (error instanceof PortInUseError) {
    console.error(error.message);
  } else {
    console.error('Application failed to start', error);
  }
  process.exitCode = 1;
});
