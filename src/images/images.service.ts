import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UsersService } from '../users/users.service';
import { MinioService } from '../upload/minio.service';
import { AiService } from './ai.service';
import { Image } from './image.entity';
import { ReferenceImage } from './types/uploaded-image-file';

export interface GenerateBatchInput {
  prompt: string;
  model?: string;
  template?: string;
  aspectRatio?: string;
  resolution?: string;
  quantity?: number;
  size?: string;
  referenceImageUrls?: string[];
}

@Injectable()
export class ImagesService {
  private readonly logger = new Logger(ImagesService.name);

  constructor(
    @InjectRepository(Image) private readonly imagesRepository: Repository<Image>,
    private readonly usersService: UsersService,
    private readonly aiService: AiService,
    private readonly minioService: MinioService,
  ) {}

  async generate(userId: number, prompt: string, model = 'gpt-image-2', size = '1024x1024', referenceImage?: ReferenceImage): Promise<Image> {
    const result = await this.generateBatch(userId, { prompt, model, size, quantity: 1 }, referenceImage);
    return result.images[0];
  }

  async generateBatch(
    userId: number,
    input: GenerateBatchInput,
    referenceImage?: ReferenceImage,
  ): Promise<{ images: Image[]; requestId: string; chargedCredits: number }> {
    const user = await this.usersService.findById(userId);
    if (!user) throw new NotFoundException('用户不存在');
    const quantity = Math.max(1, Math.min(5, Number(input.quantity) || 1));
    if (user.role !== 'admin' && user.credits < quantity) {
      throw new BadRequestException(`本次生成需要 ${quantity} 积分，当前积分不足`);
    }

    const requestId = randomUUID();
    await this.usersService.deductCredits(userId, quantity, `生成 ${quantity} 张图片`, requestId);
    const model = input.model || 'gpt-image-2';
    const aspectRatio = input.aspectRatio || '1:1';
    const resolution = input.resolution || '1K';
    const size = input.size || this.resolveImageSize(aspectRatio, resolution);
    const dimensions = this.parseImageSize(size);
    const referenceImageUrls = input.referenceImageUrls || referenceImage?.urls || null;
    const images: Image[] = [];

    for (let index = 0; index < quantity; index += 1) {
      images.push(await this.imagesRepository.save(this.imagesRepository.create({
        userId,
        requestId,
        prompt: input.prompt,
        template: input.template || 'custom',
        model,
        aspectRatio,
        resolution,
        referenceImageUrls,
        ...dimensions,
        status: 'generating',
      })));
    }

    images.forEach((image) => {
      setImmediate(() => {
        void this.processGeneration(image.id, userId, input.prompt, model, size, requestId, referenceImage);
      });
    });

    return { images, requestId, chargedCredits: user.role === 'admin' ? 0 : quantity };
  }

  private async processGeneration(
    imageId: number,
    userId: number,
    prompt: string,
    model: string,
    size: string,
    requestId: string,
    referenceImage?: ReferenceImage,
  ): Promise<void> {
    try {
      const result = await this.aiService.generateImage(prompt, model, size, referenceImage);
      if (!result.success || !result.imageBuffer) {
        await this.refundFailedImage(userId, requestId, imageId);
        await this.updateStatus(imageId, 'failed', undefined, undefined, result.error || '图片生成失败');
        return;
      }
      const imageUrl = await this.minioService.uploadImage(result.imageBuffer, userId);
      await this.updateStatus(imageId, 'completed', imageUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : '图片生成失败';
      await this.refundFailedImage(userId, requestId, imageId);
      this.logger.error(`Generation ${imageId} failed: ${message}`);
      await this.updateStatus(imageId, 'failed', undefined, undefined, message);
    }
  }

  private refundFailedImage(userId: number, requestId: string, imageId: number) {
    return this.usersService.addCredits(userId, 1, 'refund', '生成失败退还 1 积分', `${requestId}:${imageId}`);
  }

  async updateStatus(id: number, status: string, imageUrl?: string, imageKey?: string, errorMessage?: string): Promise<Image> {
    const image = await this.imagesRepository.findOne({ where: { id } });
    if (!image) throw new NotFoundException('图片记录不存在');
    image.status = status;
    if (imageUrl) image.imageUrl = imageUrl;
    if (imageKey) image.imageKey = imageKey;
    if (errorMessage) image.errorMessage = errorMessage;
    return this.imagesRepository.save(image);
  }

  findById(id: number): Promise<Image | null> {
    return this.imagesRepository.findOne({ where: { id } });
  }

  async findByUserId(userId: number, page = 1, limit = 60) {
    const safeLimit = Math.min(Math.max(Number(limit) || 60, 1), 100);
    const safePage = Math.max(Number(page) || 1, 1);
    const [images, total] = await this.imagesRepository.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    });
    return { images, total };
  }

  async deleteImage(id: number, userId: number): Promise<void> {
    const image = await this.imagesRepository.findOne({ where: { id } });
    if (!image || image.userId !== userId) throw new NotFoundException('图片不存在');
    if (image.imageKey) {
      try {
        await this.minioService.deleteImage(image.imageKey);
      } catch (error) {
        this.logger.warn(`Unable to remove stored image ${image.id}: ${String(error)}`);
      }
    }
    await this.imagesRepository.remove(image);
  }

  private resolveImageSize(aspectRatio: string, resolution: string): string {
    const longEdge = { '1K': 1024, '2K': 2048, '4K': 3840 }[resolution] || 1024;
    const [widthRatio, heightRatio] = aspectRatio.split(':').map(Number);
    if (!widthRatio || !heightRatio || widthRatio === heightRatio) return `${longEdge}x${longEdge}`;
    return widthRatio > heightRatio
      ? `${longEdge}x${Math.round((longEdge * heightRatio) / widthRatio)}`
      : `${Math.round((longEdge * widthRatio) / heightRatio)}x${longEdge}`;
  }

  private parseImageSize(size: string): { width: number; height: number } {
    const match = size.match(/^(\d+)x(\d+)$/);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 1024, height: 1024 };
  }
}
