import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Image } from './image.entity';
import { ImagesService } from './images.service';
import { ImagesController } from './images.controller';
import { AiService } from './ai.service';
import { ImageGenerationWorker } from './image-generation.worker';
import { UsersModule } from '../users/users.module';
import { UploadModule } from '../upload/upload.module';
import { ImageGenerationThrottlerGuard } from './image-generation-throttler.guard';
import { ImageUploadConcurrencyInterceptor } from './image-upload-concurrency.interceptor';
import { ImageVariantService } from './image-variant.service';

@Module({
  imports: [TypeOrmModule.forFeature([Image]), UsersModule, UploadModule],
  controllers: [ImagesController],
  providers: [
    ImagesService,
    AiService,
    ImageVariantService,
    ImageGenerationWorker,
    ImageGenerationThrottlerGuard,
    ImageUploadConcurrencyInterceptor,
  ],
  exports: [ImagesService, ImageVariantService],
})
export class ImagesModule {}
