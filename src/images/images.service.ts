import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Optional,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  And,
  DataSource,
  FindOptionsWhere,
  In,
  LessThan,
  MoreThanOrEqual,
  Raw,
  Repository,
} from 'typeorm';
import { UsersService } from '../users/users.service';
import { MinioService } from '../upload/minio.service';
import { detectImageMetadata } from '../upload/image-format';
import { AiService } from './ai.service';
import type { AiLineId } from './ai.service';
import type { ImageJobInputReference } from './generation-input';
import { ImageGenerationWorker } from './image-generation.worker';
import {
  DURABLE_IMAGE_JOB_VERSION,
  Image,
  isImageStatus,
} from './image.entity';
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

export interface FindImagesQuery {
  page?: string | number;
  limit?: string | number;
  cursor?: string;
  q?: string;
  template?: string;
  createdAfter?: string;
  status?: string;
}

interface ImageCursor {
  createdAt: string;
  id: number;
}

const MYSQL_CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

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

  async findDetailByUserId(
    id: number,
    userId: number,
  ): Promise<{ image: Image; results: Image[] }> {
    const image = await this.imagesRepository.findOne({
      where: { id, userId },
    });
    if (!image) throw new NotFoundException('图片不存在');
    if (!image.requestId) return { image, results: [image] };

    const results = await this.imagesRepository.find({
      where: { userId, requestId: image.requestId },
      order: { createdAt: 'ASC', id: 'ASC' },
      take: 5,
    });
    return { image, results };
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

  async findByUserId(userId: number, query: FindImagesQuery = {}) {
    if (query.page !== undefined && query.cursor !== undefined) {
      throw new BadRequestException('page and cursor cannot be combined');
    }

    const limit = Math.min(
      Math.max(Math.floor(Number(query.limit)) || 24, 1),
      100,
    );
    const cursor = query.cursor
      ? this.decodeImageCursor(query.cursor)
      : undefined;
    const createdAfter = query.createdAfter
      ? this.parseCreatedAfter(query.createdAfter)
      : undefined;
    const baseWhere: FindOptionsWhere<Image> = { userId };
    const search = query.q?.trim();
    const template = query.template?.trim();
    const status = query.status?.trim();
    if (search) {
      const escapedSearch = search
        .toLowerCase()
        .replaceAll('=', '==')
        .replaceAll('%', '=%')
        .replaceAll('_', '=_');
      baseWhere.prompt = Raw(
        (alias) => `LOWER(${alias}) LIKE :imageSearch ESCAPE '='`,
        { imageSearch: `%${escapedSearch}%` },
      );
    }
    if (template) baseWhere.template = template;
    if (status) {
      if (!isImageStatus(status)) {
        throw new BadRequestException('Invalid image status');
      }
      baseWhere.status = status;
    }
    if (createdAfter) baseWhere.createdAt = MoreThanOrEqual(createdAfter);
    let where: FindOptionsWhere<Image> | FindOptionsWhere<Image>[] = baseWhere;
    if (cursor) {
      where = [
        {
          ...baseWhere,
          createdAt: createdAfter
            ? And(
                MoreThanOrEqual(createdAfter),
                Raw((alias) => `${alias} < :imageCursorCreatedAt`, {
                  imageCursorCreatedAt: cursor.createdAt,
                }),
              )
            : Raw((alias) => `${alias} < :imageCursorCreatedAt`, {
                imageCursorCreatedAt: cursor.createdAt,
              }),
        },
        {
          ...baseWhere,
          createdAt: createdAfter
            ? And(
                MoreThanOrEqual(createdAfter),
                Raw((alias) => `${alias} = :imageCursorCreatedAt`, {
                  imageCursorCreatedAt: cursor.createdAt,
                }),
              )
            : Raw((alias) => `${alias} = :imageCursorCreatedAt`, {
                imageCursorCreatedAt: cursor.createdAt,
              }),
          id: LessThan(cursor.id),
        },
      ];
    }
    const page = Math.max(Math.floor(Number(query.page)) || 1, 1);

    const [rows, total, failedTotal] = await Promise.all([
      this.imagesRepository.find({
        where,
        order: { createdAt: 'DESC', id: 'DESC' },
        skip: query.page === undefined ? 0 : (page - 1) * limit,
        take: limit + 1,
      }),
      this.imagesRepository.count({ where: baseWhere }),
      this.imagesRepository.count({ where: { userId, status: 'failed' } }),
    ]);
    const hasMore = rows.length > limit;
    const images = hasMore ? rows.slice(0, limit) : rows;
    const lastImage = images.at(-1);
    const nextCursor =
      hasMore && lastImage
        ? this.encodeImageCursor(
            await this.findCursorTimestamp(lastImage.id, userId),
            lastImage.id,
          )
        : null;

    return {
      images,
      total,
      failedTotal,
      nextCursor,
    };
  }

  private async findCursorTimestamp(
    id: number,
    userId: number,
  ): Promise<string> {
    const rows = (await this.imagesRepository.query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at_cursor
       FROM images WHERE id = ? AND user_id = ? LIMIT 1`,
      [id, userId],
    )) as Array<{ created_at_cursor?: unknown }>;
    const value = String(rows[0]?.created_at_cursor || '');
    if (!MYSQL_CURSOR_TIMESTAMP.test(value)) {
      throw new Error('Unable to read image cursor timestamp');
    }
    return value;
  }

  private encodeImageCursor(createdAt: string, id: number): string {
    return Buffer.from(JSON.stringify([createdAt, id])).toString('base64url');
  }

  private decodeImageCursor(value: string): ImageCursor {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
      const payload: unknown = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      );
      if (!Array.isArray(payload) || payload.length !== 2) {
        throw new Error('Invalid payload');
      }
      const createdAtValue: unknown = payload[0];
      const idValue: unknown = payload[1];
      const createdAt = String(createdAtValue);
      const id = Number(idValue);
      if (
        !MYSQL_CURSOR_TIMESTAMP.test(createdAt) ||
        !Number.isSafeInteger(id) ||
        id <= 0
      ) {
        throw new Error('Invalid cursor values');
      }
      return { createdAt, id };
    } catch {
      throw new BadRequestException('Invalid image cursor');
    }
  }

  private parseCreatedAfter(value: string): Date {
    const createdAfter = new Date(value);
    if (Number.isNaN(createdAfter.getTime())) {
      throw new BadRequestException('Invalid createdAfter');
    }
    return createdAfter;
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
    const deletions: Promise<void>[] = [];
    if (image.imageKey) {
      deletions.push(this.minioService.deleteImage(image.imageKey));
    } else if (image.imageUrl) {
      deletions.push(this.minioService.deleteImageByUrlStrict(image.imageUrl));
    }
    if (image.thumbnailKey) {
      deletions.push(this.minioService.deleteImage(image.thumbnailKey));
    } else if (image.thumbnailUrl) {
      deletions.push(
        this.minioService.deleteImageByUrlStrict(image.thumbnailUrl),
      );
    }
    if (image.previewKey) {
      deletions.push(this.minioService.deleteImage(image.previewKey));
    } else if (image.previewUrl) {
      deletions.push(
        this.minioService.deleteImageByUrlStrict(image.previewUrl),
      );
    }
    const results = await Promise.allSettled(deletions);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) throw failure.reason;
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
