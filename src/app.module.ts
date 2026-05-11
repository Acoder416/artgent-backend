import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ImagesModule } from './images/images.module';

const envFile = `.env.${process.env.NODE_ENV || 'development'}`;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: envFile,
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'mysql',
        host: configService.get('DB_HOST', 'localhost'),
        port: configService.get<number>('DB_PORT', 3306),
        username: configService.get('DB_USERNAME', 'artgen'),
        password: configService.get('DB_PASSWORD', 'ArtGen@2026'),
        database: configService.get('DB_DATABASE', 'artgen'),
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        synchronize: false,
        charset: 'utf8mb4',
      }),
      inject: [ConfigService],
    }),
    AuthModule,
    UsersModule,
    ImagesModule,
  ],
})
export class AppModule {}
