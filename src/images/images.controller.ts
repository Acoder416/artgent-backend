import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Query,
  UseGuards,
  Request,
  ValidationPipe,
  Param,
  ParseIntPipe,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ImagesService } from './images.service';
import { AiService } from './ai.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateImageDto } from './dto/create-image.dto';
import type { UploadedImageFile } from './types/uploaded-image-file';

@Controller('images')
export class ImagesController {
  constructor(
    private readonly imagesService: ImagesService,
    private readonly aiService: AiService,
  ) {}

  @Get('models')
  async models() {
    return { models: await this.aiService.listImageModels() };
  }

  @Post('generate')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FilesInterceptor('image', 5, { limits: { fileSize: 20 * 1024 * 1024 } }))
  async generate(
    @Request() req,
    @Body(ValidationPipe) createImageDto: CreateImageDto,
    @UploadedFiles() images?: UploadedImageFile[],
  ) {
    const urls = [
      createImageDto.sourceImageUrl,
      createImageDto.referenceImageUrl,
    ].filter((url): url is string => Boolean(url));

    return this.imagesService.generate(
      req.user.id,
      createImageDto.prompt,
      createImageDto.model,
      createImageDto.size,
      {
        files: images || [],
        urls,
      },
    );
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  async findAll(
    @Request() req,
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 20,
  ) {
    return this.imagesService.findByUserId(req.user.id, page, limit);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async findOne(@Request() req, @Param('id', ParseIntPipe) id: number) {
    const image = await this.imagesService.findById(id);
    if (!image || image.userId !== req.user.id) {
      return null;
    }
    return image;
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  async remove(@Request() req, @Param('id', ParseIntPipe) id: number) {
    await this.imagesService.deleteImage(id, req.user.id);
    return { message: 'Image deleted' };
  }
}
