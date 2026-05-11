import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Image } from './image.entity';
import { ImagesService } from './images.service';
import { ImagesController } from './images.controller';
import { AiService } from './ai.service';
import { UsersModule } from '../users/users.module';
import { UploadModule } from '../upload/upload.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Image]),
    UsersModule,
    UploadModule,
  ],
  controllers: [ImagesController],
  providers: [ImagesService, AiService],
  exports: [ImagesService],
})
export class ImagesModule {}
