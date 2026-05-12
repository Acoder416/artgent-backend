import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Image } from './image.entity';
import { UsersService } from '../users/users.service';
import { AiService } from './ai.service';
import { MinioService } from '../upload/minio.service';
import { ReferenceImage } from './types/uploaded-image-file';

@Injectable()
export class ImagesService {
  private readonly logger = new Logger(ImagesService.name);

  constructor(
    @InjectRepository(Image)
    private imagesRepository: Repository<Image>,
    private usersService: UsersService,
    private aiService: AiService,
    private minioService: MinioService,
  ) {}

  /**
   * 生成图片（完整流程）
   * 1. 检查用户积分
   * 2. 创建 pending 记录
   * 3. 调用 AI 生成图片
   * 4. 上传到 MinIO
   * 5. 扣积分、更新状态
   */
  async generate(
    userId: number,
    prompt: string,
    model: string = 'gpt-image-2',
    size: string = '1024x1024',
    referenceImage?: ReferenceImage,
  ): Promise<Image> {
    // 1. 检查用户
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    if (user.credits < 1) {
      throw new BadRequestException('积分不足，请充值');
    }

    // 2. 创建记录
    const image = this.imagesRepository.create({
      userId,
      prompt,
      model,
      ...this.parseImageSize(size),
      status: 'generating',
    });
    const saved = await this.imagesRepository.save(image);

    // 3. 异步执行生成流程（不阻塞返回）
    this.processGeneration(saved.id, userId, prompt, model, size, referenceImage).catch((err) => {
      this.logger.error(`Generation failed for image ${saved.id}: ${err.message}`);
    });

    return saved;
  }

  /**
   * 后台处理图片生成
   */
  private async processGeneration(
    imageId: number,
    userId: number,
    prompt: string,
    model: string,
    size: string,
    referenceImage?: ReferenceImage,
  ): Promise<void> {
    try {
      // 调用 AI 生成
      const result = await this.aiService.generateImage(prompt, model, size, referenceImage);

      if (!result.success || !result.imageBuffer) {
        await this.updateStatus(imageId, 'failed', undefined, undefined, result.error || '生成失败');
        return;
      }

      // 上传到 MinIO
      const imageUrl = await this.minioService.uploadImage(result.imageBuffer, userId);

      // 更新状态
      await this.updateStatus(imageId, 'completed', imageUrl);

      // 扣积分
      await this.usersService.deductCredits(userId, 1);

      this.logger.log(`Image ${imageId} generated successfully`);
    } catch (error) {
      this.logger.error(`Process generation failed: ${error.message}`);
      await this.updateStatus(imageId, 'failed', undefined, undefined, error.message);
    }
  }

  async updateStatus(
    id: number,
    status: string,
    imageUrl?: string,
    imageKey?: string,
    errorMessage?: string,
  ): Promise<Image> {
    const image = await this.imagesRepository.findOne({ where: { id } });
    if (!image) {
      throw new NotFoundException('图片记录不存在');
    }

    image.status = status;
    if (imageUrl) image.imageUrl = imageUrl;
    if (imageKey) image.imageKey = imageKey;
    if (errorMessage) image.errorMessage = errorMessage;

    return this.imagesRepository.save(image);
  }

  async findById(id: number): Promise<Image | null> {
    return this.imagesRepository.findOne({ where: { id } });
  }

  async findByUserId(userId: number, page: number = 1, limit: number = 20): Promise<{ images: Image[]; total: number }> {
    const [images, total] = await this.imagesRepository.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { images, total };
  }

  async deleteImage(id: number, userId: number): Promise<void> {
    const image = await this.imagesRepository.findOne({ where: { id } });
    if (!image || image.userId !== userId) {
      throw new NotFoundException('图片不存在');
    }

    // 删除 MinIO 文件
    if (image.imageKey) {
      try {
        await this.minioService.deleteImage(image.imageKey);
      } catch (err) {
        this.logger.warn(`Failed to delete MinIO file: ${err.message}`);
      }
    }

    await this.imagesRepository.remove(image);
  }

  private parseImageSize(size: string): { width: number; height: number } {
    const match = size.match(/^(\d+)x(\d+)$/);
    if (!match) {
      return { width: 1024, height: 1024 };
    }

    return {
      width: Number(match[1]),
      height: Number(match[2]),
    };
  }
}
