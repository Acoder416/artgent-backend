import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Optional,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { UsersService } from '../users/users.service';
import { MinioService } from '../upload/minio.service';
import { detectImageMetadata } from '../upload/image-format';
import { AiService } from './ai.service';
import type { AiLineId } from './ai.service';
import type { ImageJobInputReference } from './generation-input';
import { ImageGenerationWorker } from './image-generation.worker';
import { DURABLE_IMAGE_JOB_VERSION, Image } from './image.entity';
import {
  DEFAULT_IMAGE_ASPECT_RATIO,
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_IMAGE_RESOLUTION,
  MAX_IMAGE_PIXEL_COUNT,
  resolveImageSize,
  type ImageAspectRatio,
  type ImageQuality,
  type ImageResolution,
} from './image-parameters';
import { ReferenceImage } from './types/uploaded-image-file';

export interface GenerateBatchInput {
  prompt: string;
  model?: string;
  lineId?: AiLineId;
  template?: string;
  aspectRatio?: ImageAspectRatio;
  resolution?: ImageResolution;
  quality?: ImageQuality;
  quantity?: number;
  size?: string;
  referenceImageUrls?: string[];
}

@Injectable()
export class ImagesService {
  constructor(
    @InjectRepository(Image)
    private readonly imagesRepository: Repository<Image>,
    private readonly usersService: UsersService,
    private readonly aiService: AiService,
    private readonly minioService: MinioService,
    @Optional()
    private readonly generationWorker?: ImageGenerationWorker,
    @Optional()
    private readonly dataSource?: DataSource,
  ) {}

  async generate(
    userId: number,
    prompt: string,
    model = 'gpt-image-2',
    size = '1024x1024',
    referenceImage?: ReferenceImage,
  ): Promise<Image> {
    const result = await this.generateBatch(
      userId,
      { prompt, model, size, quantity: 1 },
      referenceImage,
    );
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
    const lineId = this.aiService.resolveLineId(input.lineId);
    if (user.role !== 'admin' && user.credits < quantity) {
      throw new BadRequestException(
        `本次生成需要 ${quantity} 积分，当前积分不足`,
      );
    }
    const model = input.model || 'gpt-image-2';
    const aspectRatio = input.aspectRatio || DEFAULT_IMAGE_ASPECT_RATIO;
    const resolution = input.resolution || DEFAULT_IMAGE_RESOLUTION;
    const quality = input.quality || DEFAULT_IMAGE_QUALITY;
    const size = input.size || resolveImageSize(resolution, aspectRatio);
    const dimensions = this.parseImageSize(size);

    const requestId = randomUUID();
    const inputReferences = await this.stageInputReferences(
      userId,
      requestId,
      input.referenceImageUrls || [],
      referenceImage,
    );
    const referenceImageUrls = inputReferences.length
      ? inputReferences.map((reference) => reference.url)
      : null;
    const chargedCredits = user.role === 'admin' ? 0 : quantity;
    let requiresRefund = false;

    try {
      const jobs = Array.from({ length: quantity }, () =>
        this.imagesRepository.create({
          userId,
          requestId,
          prompt: input.prompt,
          template: input.template || 'custom',
          model,
          quality,
          lineId,
          aspectRatio,
          resolution,
          referenceImageUrls,
          inputReferences,
          jobVersion: DURABLE_IMAGE_JOB_VERSION,
          attemptCount: 0,
          availableAt: new Date(),
          ...dimensions,
          status: 'pending',
        }),
      );
      let images: Image[];
      if (this.dataSource) {
        images = await this.dataSource.transaction(async (manager) => {
          await this.usersService.deductCreditsInTransaction(
            manager,
            userId,
            quantity,
            `生成 ${quantity} 张图片`,
            requestId,
          );
          return manager.save(Image, jobs);
        });
      } else {
        await this.usersService.deductCredits(
          userId,
          quantity,
          `生成 ${quantity} 张图片`,
          requestId,
        );
        requiresRefund = chargedCredits > 0;
        images = await this.imagesRepository.save(jobs);
      }

      this.generationWorker?.wake(images.map((image) => image.id));
      return { images, requestId, chargedCredits };
    } catch (error) {
      const cleanupTasks: Promise<unknown>[] = inputReferences
        .filter((reference) => reference.kind === 'object')
        .map((reference) => this.minioService.deleteImage(reference.key));
      if (requiresRefund) {
        cleanupTasks.push(
          this.usersService.refundCreditsOnce(
            userId,
            quantity,
            `enqueue:${requestId}`,
            `Image generation enqueue failed: refund ${quantity} credits`,
          ),
        );
      }
      await Promise.allSettled(cleanupTasks);
      throw error;
    }
  }

  findById(id: number): Promise<Image | null> {
    return this.imagesRepository.findOne({ where: { id } });
  }

  async getDownload(id: number, userId: number) {
    const image = await this.imagesRepository.findOne({ where: { id } });
    if (
      !image ||
      image.userId !== userId ||
      (!image.imageKey && !image.imageUrl)
    ) {
      throw new NotFoundException('图片不存在');
    }

    const file = image.imageKey
      ? await this.minioService.openImageByKey(image.imageKey)
      : await this.minioService.openImageByUrl(image.imageUrl || '');
    const extension =
      image.imageFormat ||
      file.key.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ||
      'png';
    return { ...file, filename: `cadriva-${image.id}.${extension}` };
  }

  async findStatusesByUserId(
    userId: number,
    idsQuery?: string,
  ): Promise<Image[]> {
    if (typeof idsQuery !== 'string') {
      throw new BadRequestException(
        'ids must contain between 1 and 100 positive integers',
      );
    }
    const rawIds = idsQuery.split(',');
    if (rawIds.length === 0 || rawIds.length > 100) {
      throw new BadRequestException(
        'ids must contain between 1 and 100 positive integers',
      );
    }

    const ids = rawIds.map((rawId) => {
      const value = rawId.trim();
      if (!/^\d+$/.test(value)) {
        throw new BadRequestException(
          'ids must contain only positive integers',
        );
      }
      const id = Number(value);
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new BadRequestException(
          'ids must contain only positive integers',
        );
      }
      return id;
    });

    return this.imagesRepository.find({
      where: { userId, id: In([...new Set(ids)]) },
    });
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

  async deleteFailedImages(
    userId: number,
  ): Promise<{ deletedCount: number; deletedIds: number[] }> {
    const failedImages = await this.imagesRepository.find({
      where: { userId, status: 'failed' },
    });
    const deletedIds: number[] = [];
    for (const image of failedImages) {
      if (image.jobVersion === DURABLE_IMAGE_JOB_VERSION && !image.refundedAt)
        continue;
      try {
        await this.deleteStoredOutput(image);
        deletedIds.push(image.id);
      } catch {
        // Keep the database row so storage cleanup can be retried.
      }
    }
    if (deletedIds.length === 0) return { deletedCount: 0, deletedIds };

    const result = await this.imagesRepository.delete(deletedIds);
    return { deletedCount: result.affected ?? 0, deletedIds };
  }

  async deleteImage(id: number, userId: number): Promise<void> {
    const image = await this.imagesRepository.findOne({ where: { id } });
    if (!image || image.userId !== userId)
      throw new NotFoundException('图片不存在');
    if (image.status === 'pending' || image.status === 'generating') {
      throw new ConflictException('Image generation is still in progress');
    }
    if (
      image.status === 'failed' &&
      image.jobVersion === DURABLE_IMAGE_JOB_VERSION &&
      !image.refundedAt
    ) {
      throw new ConflictException('Image generation refund is still pending');
    }
    await this.deleteStoredOutput(image);
    await this.imagesRepository.remove(image);
  }

  private async deleteStoredOutput(image: Image): Promise<void> {
    if (image.imageKey) {
      await this.minioService.deleteImage(image.imageKey);
    } else if (image.imageUrl) {
      await this.minioService.deleteImageByUrlStrict(image.imageUrl);
    }
  }

  private async stageInputReferences(
    userId: number,
    requestId: string,
    inputUrls: string[],
    referenceImage?: ReferenceImage,
  ): Promise<ImageJobInputReference[]> {
    const files = [
      ...(referenceImage?.files || []),
      ...(referenceImage?.file ? [referenceImage.file] : []),
    ];
    const urls = Array.from(
      new Set(
        [
          ...inputUrls,
          ...(referenceImage?.urls || []),
          ...(referenceImage?.url ? [referenceImage.url] : []),
        ]
          .map((url) => url.trim())
          .filter(Boolean),
      ),
    );
    if (files.length + urls.length > 5) {
      throw new BadRequestException(
        'A maximum of 5 reference images is allowed',
      );
    }

    const references: ImageJobInputReference[] = [];
    const storedKeys: string[] = [];

    try {
      for (const [index, url] of urls.entries()) {
        let source: Awaited<ReturnType<MinioService['readImageByUrl']>>;
        try {
          source = await this.minioService.readImageByUrl(url);
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (
            message === 'Unsupported image URL' ||
            message === 'Image not found' ||
            message.startsWith('Unsupported stored image format:')
          ) {
            throw new BadRequestException(
              'Reference image URL must point to an ArtGen image',
            );
          }
          throw error;
        }

        const extension =
          source.imageFormat === 'jpeg' ? 'jpg' : source.imageFormat;
        const key =
          `job-inputs/${userId}/${requestId}/${index + 1}-` +
          `${randomUUID().slice(0, 8)}.${extension}`;
        const stored = await this.minioService.storeImage(
          source.buffer,
          userId,
          { key },
        );
        storedKeys.push(stored.key);
        const sourceSegments = source.key.split('/');
        references.push({
          kind: 'object',
          key: stored.key,
          url: stored.url,
          mimeType: stored.mimeType,
          originalName:
            sourceSegments[sourceSegments.length - 1] ||
            `reference-${index + 1}.${extension}`,
        });
      }

      for (const [index, file] of files.entries()) {
        const metadata = detectImageMetadata(file.buffer);
        if (!metadata) {
          throw new BadRequestException(
            'Reference images must be PNG, JPEG, or WebP files',
          );
        }
        const position = urls.length + index + 1;
        const key =
          `job-inputs/${userId}/${requestId}/${position}-` +
          `${randomUUID().slice(0, 8)}.${metadata.imageFormat}`;
        const stored = await this.minioService.storeImage(file.buffer, userId, {
          key,
        });
        storedKeys.push(stored.key);
        references.push({
          kind: 'object',
          key: stored.key,
          url: stored.url,
          mimeType: stored.mimeType,
          originalName:
            file.originalname ||
            `reference-${position}.${metadata.imageFormat}`,
        });
      }
      return references;
    } catch (error) {
      await Promise.allSettled(
        storedKeys.map((key) => this.minioService.deleteImage(key)),
      );
      throw error;
    }
  }
  private parseImageSize(size: string): { width: number; height: number } {
    const match = size.match(/^(\d+)x(\d+)$/);
    if (!match) throw new BadRequestException('Invalid image size');
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (
      width < 16 ||
      height < 16 ||
      width > 4096 ||
      height > 4096 ||
      width % 16 !== 0 ||
      height % 16 !== 0 ||
      width * height > MAX_IMAGE_PIXEL_COUNT
    ) {
      throw new BadRequestException(
        'Image size must use 16-pixel increments and stay within the provider pixel limit',
      );
    }
    return { width, height };
  }
}
