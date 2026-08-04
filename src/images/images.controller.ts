import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  NotFoundException,
  Post,
  Query,
  Request,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AiService } from './ai.service';
import type { AiLineId } from './ai.service';
import { CreateImageDto } from './dto/create-image.dto';
import { RewritePromptDto } from './dto/rewrite-prompt.dto';
import {
  DEFAULT_IMAGE_ASPECT_RATIO,
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_IMAGE_RESOLUTION,
} from './image-parameters';
import { ImagesService } from './images.service';
import type { UploadedImageFile } from './types/uploaded-image-file';

interface AuthenticatedRequest {
  user: { id: number };
}

function resolveAlias<T>(
  current: T | undefined,
  alias: T | undefined,
  fieldName: string,
): T | undefined {
  if (current !== undefined && alias !== undefined && current !== alias) {
    throw new BadRequestException(`${fieldName} aliases must match`);
  }
  return current ?? alias;
}

@Controller('images')
export class ImagesController {
  constructor(
    private readonly imagesService: ImagesService,
    private readonly aiService: AiService,
  ) {}

  @Get('lines')
  lines() {
    return this.aiService.listLines();
  }

  @Get('models')
  async models(@Query('lineId') lineId?: AiLineId) {
    return { models: await this.aiService.listImageModels(lineId) };
  }

  @Post('rewrite-prompt')
  @UseGuards(JwtAuthGuard)
  async rewritePrompt(@Body(ValidationPipe) dto: RewritePromptDto) {
    return {
      prompt: await this.aiService.rewritePrompt(dto),
    };
  }

  @Post('generate')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FilesInterceptor('images', 5, { limits: { fileSize: 20 * 1024 * 1024 } }),
  )
  generate(
    @Request() req: AuthenticatedRequest,
    @Body(ValidationPipe) dto: CreateImageDto,
    @UploadedFiles() images?: UploadedImageFile[],
  ) {
    const urls = [dto.sourceImageUrl, dto.referenceImageUrl].filter(
      (url): url is string => Boolean(url),
    );
    const aspectRatio =
      resolveAlias(dto.aspectRatio, dto.aspect_ratio, 'aspect ratio') ??
      DEFAULT_IMAGE_ASPECT_RATIO;
    const quantity = resolveAlias(dto.quantity, dto.n, 'quantity') ?? 1;
    return this.imagesService.generateBatch(
      req.user.id,
      {
        prompt: dto.prompt,
        model: dto.model,
        lineId: dto.lineId,
        template: dto.template,
        aspectRatio,
        resolution: dto.resolution ?? DEFAULT_IMAGE_RESOLUTION,
        quality: dto.quality ?? DEFAULT_IMAGE_QUALITY,
        quantity,
        size: dto.size,
        referenceImageUrls: urls,
      },
      { files: images || [], urls },
    );
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  findAll(
    @Request() req: AuthenticatedRequest,
    @Query('page') page = 1,
    @Query('limit') limit = 60,
  ) {
    return this.imagesService.findByUserId(req.user.id, page, limit);
  }

  @Get('statuses')
  @UseGuards(JwtAuthGuard)
  async findStatuses(
    @Request() req: AuthenticatedRequest,
    @Query('ids') ids?: string,
  ) {
    return {
      images: await this.imagesService.findStatusesByUserId(req.user.id, ids),
    };
  }

  @Delete('failed')
  @UseGuards(JwtAuthGuard)
  deleteFailed(@Request() req: AuthenticatedRequest) {
    return this.imagesService.deleteFailedImages(req.user.id);
  }

  @Get(':id/download')
  @UseGuards(JwtAuthGuard)
  async download(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const file = await this.imagesService.getDownload(id, req.user.id);
    return new StreamableFile(file.stream, {
      type: file.contentType,
      length: file.size,
      disposition: `attachment; filename="${file.filename}"`,
    });
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async findOne(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const image = await this.imagesService.findById(id);
    if (!image || image.userId !== req.user.id) {
      throw new NotFoundException('图片不存在');
    }
    return image;
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  async remove(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.imagesService.deleteImage(id, req.user.id);
    return { message: '作品已删除' };
  }
}
