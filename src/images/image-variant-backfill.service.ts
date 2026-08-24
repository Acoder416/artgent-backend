import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { MinioService, StoredImage } from '../upload/minio.service';
import { Image } from './image.entity';
import { imageVariantKeys } from './image-variant';
import { ImageVariantService } from './image-variant.service';

export interface ImageVariantBackfillOptions {
  apply?: boolean;
  afterId?: number;
  batchSize?: number;
  concurrency?: number;
}

export interface ImageVariantBackfillResult {
  scanned: number;
  succeeded: number;
  failed: number;
  lastId: number;
  failures: Array<{ id: number; message: string }>;
}

@Injectable()
export class ImageVariantBackfillService {
  constructor(
    @InjectRepository(Image)
    private readonly imagesRepository: Repository<Image>,
    private readonly minioService: MinioService,
    private readonly imageVariantService: ImageVariantService,
  ) {}

  async run(
    options: ImageVariantBackfillOptions = {},
  ): Promise<ImageVariantBackfillResult> {
    const apply = options.apply === true;
    const batchSize = this.clamp(options.batchSize, 10, 1, 100);
    const concurrency = this.clamp(options.concurrency, 2, 1, 4);
    const result: ImageVariantBackfillResult = {
      scanned: 0,
      succeeded: 0,
      failed: 0,
      lastId: Math.max(0, Math.floor(options.afterId ?? 0)),
      failures: [],
    };

    while (true) {
      const batch = await this.imagesRepository.find({
        where: [
          {
            id: MoreThan(result.lastId),
            status: 'completed',
            thumbnailUrl: IsNull(),
          },
          {
            id: MoreThan(result.lastId),
            status: 'completed',
            previewUrl: IsNull(),
          },
          {
            id: MoreThan(result.lastId),
            status: 'completed',
            thumbnailKey: IsNull(),
          },
          {
            id: MoreThan(result.lastId),
            status: 'completed',
            previewKey: IsNull(),
          },
        ],
        order: { id: 'ASC' },
        take: batchSize,
      });
      if (batch.length === 0) break;

      result.scanned += batch.length;
      result.lastId = batch[batch.length - 1].id;
      if (!apply) continue;

      await this.forEachConcurrent(batch, concurrency, async (image) => {
        try {
          await this.backfillOne(image);
          result.succeeded += 1;
        } catch (error: unknown) {
          result.failed += 1;
          result.failures.push({
            id: image.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }

    return result;
  }

  private async backfillOne(image: Image): Promise<void> {
    const original = await this.readOriginal(image);
    const keys = imageVariantKeys(original.key);
    const uploadedKeys: string[] = [];

    try {
      const [existingThumbnail, existingPreview] = await Promise.all([
        this.resolveStoredVariant(image.thumbnailKey, image.thumbnailUrl),
        this.resolveStoredVariant(image.previewKey, image.previewUrl),
      ]);
      const generated =
        existingThumbnail && existingPreview
          ? null
          : await this.imageVariantService.generate(original.buffer);
      const thumbnail =
        existingThumbnail ||
        (await this.ensureStoredVariant(
          image.thumbnailKey || keys.thumbnail,
          generated!.thumbnail,
          image.userId,
          uploadedKeys,
        ));
      const preview =
        existingPreview ||
        (await this.ensureStoredVariant(
          image.previewKey || keys.preview,
          generated!.preview,
          image.userId,
          uploadedKeys,
        ));
      const criteria = image.imageKey
        ? {
            id: image.id,
            status: 'completed' as const,
            imageKey: image.imageKey,
          }
        : {
            id: image.id,
            status: 'completed' as const,
            imageKey: IsNull(),
            imageUrl: image.imageUrl || IsNull(),
          };
      const update = await this.imagesRepository.update(criteria, {
        imageKey: original.key,
        imageUrl: original.url,
        mimeType: original.mimeType,
        imageFormat: original.imageFormat,
        thumbnailKey: thumbnail.key,
        thumbnailUrl: thumbnail.url,
        previewKey: preview.key,
        previewUrl: preview.url,
      });
      if (update.affected !== 1) {
        const current = await this.imagesRepository.findOne({
          select: {
            imageKey: true,
            thumbnailKey: true,
            previewKey: true,
          },
          where: { id: image.id },
        });
        if (
          current?.imageKey === original.key &&
          current.thumbnailKey === thumbnail.key &&
          current.previewKey === preview.key
        ) {
          return;
        }
        throw new Error('Image changed while variants were being backfilled');
      }
    } catch (error: unknown) {
      await this.cleanupUploadedKeys(image.id, uploadedKeys);
      throw error;
    }
  }

  private async cleanupUploadedKeys(
    imageId: number,
    uploadedKeys: string[],
  ): Promise<void> {
    if (uploadedKeys.length === 0) return;
    let current: Pick<Image, 'imageKey' | 'thumbnailKey' | 'previewKey'> | null;
    try {
      current = await this.imagesRepository.findOne({
        select: {
          imageKey: true,
          thumbnailKey: true,
          previewKey: true,
        },
        where: { id: imageId },
      });
    } catch {
      // Inspection failure must not risk deleting an object another run committed.
      return;
    }
    const referencedKeys = new Set(
      [current?.imageKey, current?.thumbnailKey, current?.previewKey].filter(
        (key): key is string => Boolean(key),
      ),
    );
    await Promise.allSettled(
      uploadedKeys
        .filter((key) => !referencedKeys.has(key))
        .map((key) => this.minioService.deleteImage(key)),
    );
  }

  private async readOriginal(image: Image): Promise<{
    key: string;
    url: string;
    mimeType: StoredImage['mimeType'];
    imageFormat: StoredImage['imageFormat'];
    buffer: Buffer;
  }> {
    if (!image.imageKey) {
      if (!image.imageUrl) throw new Error('Completed image has no original');
      return this.minioService.readImageByUrl(image.imageUrl);
    }

    const stored = await this.minioService.statImage(image.imageKey);
    if (!stored) throw new Error('Original image object is missing');
    return {
      ...stored,
      buffer: await this.minioService.readImage(stored.key),
    };
  }

  private async ensureStoredVariant(
    key: string,
    buffer: Buffer,
    userId: number,
    uploadedKeys: string[],
  ): Promise<StoredImage> {
    const existing = await this.minioService.statImage(key);
    if (existing) return existing;

    const stored = await this.minioService.storeImage(buffer, userId, { key });
    uploadedKeys.push(stored.key);
    return stored;
  }

  private async resolveStoredVariant(
    key: string | null,
    url: string | null,
  ): Promise<StoredImage | null> {
    if (key) {
      const stored = await this.minioService.statImage(key);
      if (stored) return stored;
    }
    if (url) return this.minioService.statImageByUrl(url);
    return null;
  }

  private async forEachConcurrent<T>(
    values: T[],
    concurrency: number,
    action: (value: T) => Promise<void>,
  ): Promise<void> {
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, values.length) },
      async () => {
        while (nextIndex < values.length) {
          const value = values[nextIndex];
          nextIndex += 1;
          await action(value);
        }
      },
    );
    await Promise.all(workers);
  }

  private clamp(
    value: number | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed)
      ? Math.min(Math.max(parsed, minimum), maximum)
      : fallback;
  }
}
