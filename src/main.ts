import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import * as mysql from 'mysql2/promise';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 读取 .env 文件中的配置
 */
function loadEnvConfig(): Record<string, string> {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const envFile = path.resolve(process.cwd(), '.env.' + nodeEnv);
  const config: Record<string, string> = {};
  
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();
        config[key] = value;
      }
    }
  }
  return config;
}

/**
 * 自动建库 + 建表
 */
async function ensureDatabase() {
  const envConfig = loadEnvConfig();
  const host = envConfig.DB_HOST || 'localhost';
  const port = parseInt(envConfig.DB_PORT || '3306');
  const username = envConfig.DB_USERNAME || 'artgen';
  const password = envConfig.DB_PASSWORD || '';
  const database = envConfig.DB_DATABASE || 'artgen';

  const connection = await mysql.createConnection({ host, port, user: username, password });
  await connection.execute(
    'CREATE DATABASE IF NOT EXISTS `' + database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
  );
  console.log('[DB] Database "' + database + '" ensured');
  await connection.end();
}

async function bootstrap() {
  // 先建库（在 NestJS 启动之前）
  await ensureDatabase();

  // 再启动 NestJS（此时数据库已存在，TypeORM 可正常连接建表）
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  app.enableCors({
    origin: configService.get('FRONTEND_URL', 'http://localhost:3002'),
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('api');

  const port = configService.get('PORT', 3001);
  await app.listen(port);
  console.log('Application is running on: http://localhost:' + port);
}

bootstrap();
