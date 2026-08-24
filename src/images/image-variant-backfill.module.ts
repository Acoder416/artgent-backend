import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UploadModule } from '../upload/upload.module';
import { CreditTransaction } from '../users/credit-transaction.entity';
import { User } from '../users/user.entity';
import { Image } from './image.entity';
import { ImageVariantBackfillService } from './image-variant-backfill.service';
import { ImageVariantService } from './image-variant.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: `.env.${process.env.NODE_ENV || 'development'}`,
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'mysql',
        host: configService.get('DB_HOST', 'localhost'),
        port: configService.get<number>('DB_PORT', 3306),
        username: configService.get('DB_USERNAME', 'artgen'),
        password: configService.get('DB_PASSWORD', ''),
        database: configService.get('DB_DATABASE', 'artgen'),
        entities: [Image, User, CreditTransaction],
        synchronize: false,
        charset: 'utf8mb4',
        retryAttempts: 3,
        retryDelay: 2_000,
      }),
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([Image]),
    UploadModule,
  ],
  providers: [ImageVariantService, ImageVariantBackfillService],
})
export class ImageVariantBackfillModule {}
