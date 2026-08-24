import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import {
  FindOptionsWhere,
  IsNull,
  LessThan,
  LessThanOrEqual,
  MoreThan,
  Not,
  Repository,
} from 'typeorm';
import { UsersService } from '../users/users.service';
import type { ImageFormat } from '../upload/image-format';
import { MinioService, type StoredImage } from '../upload/minio.service';
import { AiService } from './ai.service';
import type { ImageJobInputReference } from './generation-input';
import { imageVariantKeys } from './image-variant';
import { ImageVariantService } from './image-variant.service';
import {
  DURABLE_IMAGE_JOB_VERSION,
  Image,
  LEGACY_IMAGE_JOB_VERSION,
} from './image.entity';
import { DEFAULT_IMAGE_QUALITY } from './image-parameters';
import type { ReferenceImage } from './types/uploaded-image-file';

const RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

interface StoredImageVariants {
  thumbnail?: StoredImage;
  preview?: StoredImage;
}

@Injectable()
export class ImageGenerationWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ImageGenerationWorker.name);
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly shutdownGraceMs: number;
  private readonly maxAttempts: number;
  private readonly queuedIds: number[] = [];
  private readonly scheduledIds = new Set<number>();
  private readonly activeJobs = new Set<Promise<void>>();
  private readonly pendingOutputCleanup = new Map<string, number>();
  private cleanupCursor = 0;
  private pollTimer?: NodeJS.Timeout;
  private scanPromise?: Promise<void>;
  private stopping = false;

  constructor(
    @InjectRepository(Image)
    private readonly imagesRepository: Repository<Image>,
    private readonly aiService: AiService,
    private readonly minioService: MinioService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
    @Optional()
    private readonly imageVariantService?: ImageVariantService,
  ) {
    this.concurrency = this.integerConfig(
      'IMAGE_WORKER_CONCURRENCY',
      10,
      1,
      20,
    );
    this.pollIntervalMs = this.integerConfig(
      'IMAGE_QUEUE_POLL_INTERVAL_MS',
      2_000,
      250,
      60_000,
    );
    this.leaseDurationMs = this.integerConfig(
      'IMAGE_JOB_LEASE_MS',
      120_000,
      30_000,
      30 * 60_000,
    );
    this.heartbeatIntervalMs = Math.min(
      this.integerConfig('IMAGE_JOB_HEARTBEAT_MS', 30_000, 5_000, 5 * 60_000),
      Math.floor(this.leaseDurationMs / 2),
    );
    this.shutdownGraceMs = this.integerConfig(
      'IMAGE_WORKER_SHUTDOWN_GRACE_MS',
      10_000,
      0,
      60_000,
    );
    this.maxAttempts = this.integerConfig('IMAGE_JOB_MAX_ATTEMPTS', 3, 1, 10);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.failInterruptedLegacyJobs();
    await this.scanForWork();
    this.pollTimer = setInterval(() => {
      void this.scanForWork();
    }, this.pollIntervalMs);
    this.pollTimer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.shutdownGraceMs === 0) return;

    const pendingWork = Array.from(this.activeJobs);
    if (this.scanPromise) pendingWork.push(this.scanPromise);
    if (pendingWork.length === 0) return;

    let graceTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(pendingWork),
        new Promise<void>((resolve) => {
          graceTimer = setTimeout(resolve, this.shutdownGraceMs);
          graceTimer.unref();
        }),
      ]);
    } finally {
      if (graceTimer) clearTimeout(graceTimer);
    }
  }

  wake(imageIds: number[] = []): void {
    if (this.stopping) return;
    if (imageIds.length === 0) {
      void this.scanForWork();
      return;
    }
    this.enqueue(imageIds);
  }

  private enqueue(imageIds: number[]): void {
    for (const imageId of imageIds) {
      if (this.scheduledIds.has(imageId)) continue;
      this.scheduledIds.add(imageId);
      this.queuedIds.push(imageId);
    }
    this.drain();
  }

  private drain(): void {
    while (
      !this.stopping &&
      this.activeJobs.size < this.concurrency &&
      this.queuedIds.length > 0
    ) {
      const imageId = this.queuedIds.shift();
      if (imageId === undefined) return;

      const job = this.processJob(imageId)
        .catch((error: unknown) => {
          this.logger.error(
            `Image job ${imageId} crashed: ${this.errorMessage(error)}`,
          );
        })
        .finally(() => {
          this.activeJobs.delete(job);
          this.scheduledIds.delete(imageId);
          this.drain();
          void this.scanForWork();
        });
      this.activeJobs.add(job);
    }
  }

  private scanForWork(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.scanPromise) return this.scanPromise;

    const scan = this.performScan();
    this.scanPromise = scan;
    void scan.finally(() => {
      if (this.scanPromise === scan) this.scanPromise = undefined;
    });
    return scan;
  }

  private async performScan(): Promise<void> {
    try {
      await this.reconcileOutputCleanup();
      const now = new Date();
      const where: FindOptionsWhere<Image>[] = [
        {
          jobVersion: DURABLE_IMAGE_JOB_VERSION,
          status: 'pending',
          availableAt: LessThanOrEqual(now),
        },
        {
          jobVersion: DURABLE_IMAGE_JOB_VERSION,
          status: 'generating',
          leaseExpiresAt: LessThan(now),
        },
        {
          jobVersion: DURABLE_IMAGE_JOB_VERSION,
          status: 'generating',
          leaseExpiresAt: IsNull(),
        },
      ];
      const jobs = await this.imagesRepository.find({
        select: { id: true },
        where,
        order: { availableAt: 'ASC', id: 'ASC' },
        take: Math.max(50, this.concurrency * 4),
      });
      this.enqueue(jobs.map((job) => job.id));
      await this.reconcileRefunds();
      await this.reconcileInputCleanup();
    } catch (error: unknown) {
      this.logger.error(`Image queue scan failed: ${this.errorMessage(error)}`);
    }
  }

  private async processJob(imageId: number): Promise<void> {
    const claimed = await this.claimJob(imageId);
    if (!claimed) return;

    const heartbeat = setInterval(() => {
      void this.renewLease(claimed.id, claimed.leaseToken || '');
    }, this.heartbeatIntervalMs);
    heartbeat.unref();

    try {
      const storedOutput = await this.findStoredOutput(claimed);
      if (storedOutput) {
        const variants = await this.storeVariantsBestEffort(
          claimed,
          storedOutput,
        );
        await this.completeJob(claimed, storedOutput, variants);
        return;
      }

      const referenceImage = await this.loadReferenceImage(
        claimed.inputReferences || [],
      );
      const result = await this.aiService.generateImage(
        claimed.prompt,
        claimed.model,
        `${claimed.width}x${claimed.height}`,
        referenceImage,
        claimed.lineId,
        claimed.quality || DEFAULT_IMAGE_QUALITY,
      );

      if (!result.success) {
        await this.handleFailure(
          claimed,
          result.error || 'Image generation failed',
          result.retryable,
        );
        return;
      }

      const leaseToken = claimed.leaseToken;
      if (!leaseToken) return;
      const outputKey = this.outputKey(
        claimed.userId,
        claimed.id,
        leaseToken,
        result.imageFormat,
      );
      if (!(await this.reserveOutputKey(claimed, outputKey))) return;

      const stored = await this.minioService.storeImage(
        result.imageBuffer,
        claimed.userId,
        {
          key: outputKey,
        },
      );
      const variants = await this.storeVariantsBestEffort(
        claimed,
        stored,
        result.imageBuffer,
      );
      if (!(await this.completeJob(claimed, stored, variants))) {
        await this.cleanupUnreferencedOutput(claimed.id, stored.key, [
          variants.thumbnail?.key,
          variants.preview?.key,
        ]);
      }
    } catch (error: unknown) {
      await this.handleFailure(claimed, this.errorMessage(error), true);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async claimJob(imageId: number): Promise<Image | null> {
    const existing = await this.imagesRepository.findOne({
      where: { id: imageId },
    });
    if (!existing || existing.jobVersion !== 1) return null;

    const now = new Date();
    if (
      existing.status === 'pending' &&
      existing.availableAt &&
      existing.availableAt.getTime() > now.getTime()
    ) {
      return null;
    }
    const staleLease =
      existing.status === 'generating' &&
      (!existing.leaseExpiresAt ||
        existing.leaseExpiresAt.getTime() <= now.getTime());
    if (existing.status !== 'pending' && !staleLease) return null;

    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseDurationMs);
    const criteria: FindOptionsWhere<Image> =
      existing.status === 'pending'
        ? {
            id: imageId,
            jobVersion: DURABLE_IMAGE_JOB_VERSION,
            status: 'pending',
            attemptCount: existing.attemptCount,
          }
        : {
            id: imageId,
            jobVersion: DURABLE_IMAGE_JOB_VERSION,
            status: 'generating',
            attemptCount: existing.attemptCount,
            ...(existing.leaseToken
              ? { leaseToken: existing.leaseToken }
              : { leaseToken: IsNull() }),
            ...(existing.leaseExpiresAt
              ? { leaseExpiresAt: existing.leaseExpiresAt }
              : { leaseExpiresAt: IsNull() }),
          };
    const claimed = await this.imagesRepository.update(criteria, {
      status: 'generating',
      leaseToken,
      leaseExpiresAt,
      startedAt: existing.startedAt || now,
      attemptCount: existing.attemptCount + 1,
      errorMessage: null,
    });
    if (claimed.affected !== 1) return null;

    return this.imagesRepository.findOne({
      where: { id: imageId, leaseToken },
    });
  }

  private async renewLease(imageId: number, leaseToken: string): Promise<void> {
    if (!leaseToken) return;
    try {
      await this.imagesRepository.update(
        this.leaseCriteria(imageId, leaseToken),
        {
          leaseExpiresAt: new Date(Date.now() + this.leaseDurationMs),
        },
      );
    } catch (error: unknown) {
      this.logger.warn(
        `Unable to renew image job ${imageId}: ${this.errorMessage(error)}`,
      );
    }
  }

  private leaseCriteria(
    imageId: number,
    leaseToken: string | null,
  ): FindOptionsWhere<Image> {
    return { id: imageId, status: 'generating', leaseToken: leaseToken || '' };
  }

  private async reserveOutputKey(
    image: Image,
    imageKey: string,
  ): Promise<boolean> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseDurationMs);
    const previousImageKey = image.imageKey;
    const deterministicPreviousVariants = previousImageKey
      ? imageVariantKeys(previousImageKey)
      : null;
    const previousOutputKeys = Array.from(
      new Set(
        [
          previousImageKey,
          image.thumbnailKey,
          image.previewKey,
          deterministicPreviousVariants?.thumbnail,
          deterministicPreviousVariants?.preview,
        ].filter((key): key is string => Boolean(key)),
      ),
    );
    const reserved = await this.imagesRepository.update(
      {
        ...this.leaseCriteria(image.id, image.leaseToken),
        leaseExpiresAt: MoreThan(now),
      },
      {
        imageKey,
        thumbnailUrl: null,
        thumbnailKey: null,
        previewUrl: null,
        previewKey: null,
        leaseExpiresAt,
      },
    );
    if (reserved.affected !== 1) {
      this.logger.warn(
        `Skipped image upload after losing job lease: ${image.id}`,
      );
      return false;
    }

    image.imageKey = imageKey;
    image.thumbnailUrl = null;
    image.thumbnailKey = null;
    image.previewUrl = null;
    image.previewKey = null;
    image.leaseExpiresAt = leaseExpiresAt;
    if (previousImageKey && previousImageKey !== imageKey) {
      for (const previousOutputKey of previousOutputKeys) {
        await this.deleteOutputBestEffort(image.id, previousOutputKey);
      }
    }
    return true;
  }

  private async findStoredOutput(image: Image): Promise<StoredImage | null> {
    if (image.imageKey) {
      const persisted = await this.minioService.statImage(image.imageKey);
      if (persisted) return persisted;
    }

    return null;
  }

  private async storeVariantsBestEffort(
    image: Image,
    original: StoredImage,
    sourceBuffer?: Buffer,
  ): Promise<StoredImageVariants> {
    const variants: StoredImageVariants = {};
    if (!this.imageVariantService) return variants;

    const keys = imageVariantKeys(original.key);
    try {
      const [thumbnail, preview] = await Promise.all([
        this.minioService.statImage(keys.thumbnail),
        this.minioService.statImage(keys.preview),
      ]);
      if (thumbnail) variants.thumbnail = thumbnail;
      if (preview) variants.preview = preview;
      if (thumbnail && preview) return variants;

      const source =
        sourceBuffer || (await this.minioService.readImage(original.key));
      const generated = await this.imageVariantService.generate(source);
      const pending: Array<{
        kind: keyof StoredImageVariants;
        key: string;
        buffer: Buffer;
      }> = [];
      if (!thumbnail) {
        pending.push({
          kind: 'thumbnail',
          key: keys.thumbnail,
          buffer: generated.thumbnail,
        });
      }
      if (!preview) {
        pending.push({
          kind: 'preview',
          key: keys.preview,
          buffer: generated.preview,
        });
      }

      const uploads = await Promise.allSettled(
        pending.map((variant) =>
          this.minioService.storeImage(variant.buffer, image.userId, {
            key: variant.key,
          }),
        ),
      );
      uploads.forEach((upload, index) => {
        const variant = pending[index];
        if (upload.status === 'fulfilled') {
          if (variant.kind === 'thumbnail') variants.thumbnail = upload.value;
          if (variant.kind === 'preview') variants.preview = upload.value;
          return;
        }
        this.logger.warn(
          `Unable to store ${variant.kind} for image ${image.id}: ${this.errorMessage(upload.reason)}`,
        );
      });
    } catch (error: unknown) {
      this.logger.warn(
        `Unable to create image variants for image ${image.id}: ${this.errorMessage(error)}`,
      );
    }

    return variants;
  }

  private async cleanupUnreferencedOutput(
    imageId: number,
    imageKey: string,
    relatedKeys: Array<string | undefined> = [],
  ): Promise<void> {
    try {
      const current = await this.imagesRepository.findOne({
        select: {
          imageKey: true,
          thumbnailKey: true,
          previewKey: true,
          status: true,
        },
        where: { id: imageId },
      });
      if (current?.imageKey === imageKey && current.status !== 'failed') return;
      const outputKeys = [imageKey, ...relatedKeys].filter(
        (key): key is string => Boolean(key),
      );
      for (const outputKey of outputKeys) {
        await this.deleteOutputBestEffort(imageId, outputKey);
      }
    } catch (error: unknown) {
      this.logger.warn(
        `Unable to inspect stale output for image ${imageId}: ${this.errorMessage(error)}`,
      );
    }
  }

  private async deleteOutputBestEffort(
    imageId: number,
    imageKey: string,
  ): Promise<void> {
    try {
      await this.minioService.deleteImage(imageKey);
      this.pendingOutputCleanup.delete(imageKey);
    } catch (error: unknown) {
      this.pendingOutputCleanup.set(imageKey, imageId);
      this.logger.warn(
        `Unable to delete stale output for image ${imageId}: ${this.errorMessage(error)}`,
      );
    }
  }

  private async reconcileOutputCleanup(): Promise<void> {
    const pending = Array.from(this.pendingOutputCleanup);
    for (const [imageKey, imageId] of pending) {
      await this.deleteOutputBestEffort(imageId, imageKey);
    }
  }

  private async loadReferenceImage(
    references: ImageJobInputReference[],
  ): Promise<ReferenceImage | undefined> {
    if (references.length === 0) return undefined;
    const files: NonNullable<ReferenceImage['files']> = [];

    for (const [index, reference] of references.entries()) {
      if (reference.kind === 'url') {
        const source = await this.minioService.readImageByUrl(reference.url);
        const sourceSegments = source.key.split('/');
        const extension =
          source.imageFormat === 'jpeg' ? 'jpg' : source.imageFormat;
        files.push({
          buffer: source.buffer,
          mimetype: source.mimeType,
          originalname:
            sourceSegments[sourceSegments.length - 1] ||
            `reference-${index + 1}.${extension}`,
        });
        continue;
      }

      files.push({
        buffer: await this.minioService.readImage(reference.key),
        mimetype: reference.mimeType,
        originalname: reference.originalName,
      });
    }

    return { files };
  }

  private async completeJob(
    image: Image,
    stored: StoredImage,
    variants: StoredImageVariants = {},
  ): Promise<boolean> {
    const result = await this.imagesRepository.update(
      this.leaseCriteria(image.id, image.leaseToken),
      {
        status: 'completed',
        imageUrl: stored.url,
        imageKey: stored.key,
        thumbnailUrl: variants.thumbnail?.url || null,
        thumbnailKey: variants.thumbnail?.key || null,
        previewUrl: variants.preview?.url || null,
        previewKey: variants.preview?.key || null,
        mimeType: stored.mimeType,
        imageFormat: stored.imageFormat,
        errorMessage: null,
        finishedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
      },
    );
    if (result.affected === 1) {
      await this.cleanupInputObjectsAfterTerminal(image);
      return true;
    }
    this.logger.warn(
      `Ignored completion from expired image job lease: ${image.id}`,
    );
    return false;
  }

  private async handleFailure(
    image: Image,
    message: string,
    retryable: boolean,
  ): Promise<void> {
    const errorMessage = message.slice(0, 4_000);
    if (retryable && image.attemptCount < this.maxAttempts) {
      const retryDelay =
        RETRY_DELAYS_MS[
          Math.min(image.attemptCount - 1, RETRY_DELAYS_MS.length - 1)
        ];
      await this.imagesRepository.update(
        this.leaseCriteria(image.id, image.leaseToken),
        {
          status: 'pending',
          availableAt: new Date(Date.now() + retryDelay),
          errorMessage,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      );
      return;
    }

    const failed = await this.imagesRepository.update(
      this.leaseCriteria(image.id, image.leaseToken),
      {
        status: 'failed',
        errorMessage,
        finishedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
      },
    );
    if (failed.affected === 1) {
      try {
        await this.refundImage(image);
      } finally {
        await this.cleanupInputObjectsAfterTerminal(image);
      }
    }
  }

  private async refundImage(image: Image): Promise<void> {
    if (image.refundedAt) return;
    const referenceId = `${image.requestId || 'image'}:${image.id}`;
    await this.usersService.refundCreditsOnce(
      image.userId,
      1,
      referenceId,
      'Image generation failed: refund 1 credit',
    );
    await this.imagesRepository.update(
      {
        id: image.id,
        status: 'failed',
        refundedAt: IsNull(),
      },
      { refundedAt: new Date() },
    );
  }

  private async cleanupInputObjectsAfterTerminal(image: Image): Promise<void> {
    const references = image.inputReferences;
    if (references == null) return;
    const objectKeys = Array.from(
      new Set(
        references
          .filter(
            (
              reference,
            ): reference is Extract<
              ImageJobInputReference,
              { kind: 'object' }
            > =>
              reference.kind === 'object' &&
              reference.key.startsWith('job-inputs/'),
          )
          .map((reference) => reference.key),
      ),
    );

    try {
      if (objectKeys.length > 0 && image.requestId) {
        const activeSiblings = await this.imagesRepository.count({
          where: [
            { requestId: image.requestId, status: 'pending' },
            { requestId: image.requestId, status: 'generating' },
          ],
        });
        if (activeSiblings > 0) return;
      }

      const deletions = await Promise.allSettled(
        objectKeys.map((key) => this.minioService.deleteImage(key)),
      );
      const failedKeys = new Set<string>();
      deletions.forEach((deletion, index) => {
        if (deletion.status === 'rejected') {
          failedKeys.add(objectKeys[index]);
          this.logger.warn(
            `Unable to clean staged image ${objectKeys[index]}: ${this.errorMessage(deletion.reason)}`,
          );
        }
      });

      const remainingReferences = references.filter(
        (reference) =>
          reference.kind === 'object' && failedKeys.has(reference.key),
      );
      const inputReferences =
        remainingReferences.length > 0 ? remainingReferences : null;
      const updated = await this.imagesRepository.update(
        { id: image.id },
        { inputReferences },
      );
      if (updated.affected === 1) image.inputReferences = inputReferences;
    } catch (error: unknown) {
      this.logger.warn(
        `Unable to clean staged inputs for image ${image.id}: ${this.errorMessage(error)}`,
      );
    }
  }

  private async reconcileRefunds(): Promise<void> {
    const failedJobs = await this.imagesRepository.find({
      where: {
        jobVersion: DURABLE_IMAGE_JOB_VERSION,
        status: 'failed',
        refundedAt: IsNull(),
      },
      order: { id: 'ASC' },
      take: 50,
    });
    for (const failedJob of failedJobs) {
      try {
        await this.refundImage(failedJob);
      } catch (error: unknown) {
        this.logger.error(
          `Unable to refund image job ${failedJob.id}: ${this.errorMessage(error)}`,
        );
      }
    }
  }

  private async reconcileInputCleanup(): Promise<void> {
    const terminalJobs = await this.imagesRepository.find({
      select: {
        id: true,
        requestId: true,
        inputReferences: true,
      },
      where: [
        {
          id: MoreThan(this.cleanupCursor),
          status: 'completed',
          inputReferences: Not(IsNull()),
        },
        {
          id: MoreThan(this.cleanupCursor),
          status: 'failed',
          inputReferences: Not(IsNull()),
        },
      ],
      order: { id: 'ASC' },
      take: 50,
    });
    if (terminalJobs.length === 0) {
      this.cleanupCursor = 0;
      return;
    }
    this.cleanupCursor = terminalJobs[terminalJobs.length - 1].id;

    for (const terminalJob of terminalJobs) {
      await this.cleanupInputObjectsAfterTerminal(terminalJob);
    }
  }

  private async failInterruptedLegacyJobs(): Promise<void> {
    while (!this.stopping) {
      const legacyJobs = await this.imagesRepository.find({
        where: {
          jobVersion: LEGACY_IMAGE_JOB_VERSION,
          status: 'generating',
        },
        order: { id: 'ASC' },
        take: 500,
      });
      if (legacyJobs.length === 0) return;

      let transitioned = 0;
      for (const legacyJob of legacyJobs) {
        const failed = await this.imagesRepository.update(
          {
            id: legacyJob.id,
            jobVersion: LEGACY_IMAGE_JOB_VERSION,
            status: 'generating',
          },
          {
            jobVersion: DURABLE_IMAGE_JOB_VERSION,
            status: 'failed',
            errorMessage:
              'Generation was interrupted by the queue upgrade; please retry',
            finishedAt: new Date(),
          },
        );
        if (failed.affected === 1) {
          transitioned += 1;
          try {
            await this.refundImage(legacyJob);
          } catch (error: unknown) {
            this.logger.error(
              `Unable to refund interrupted image ${legacyJob.id}: ${this.errorMessage(error)}`,
            );
          }
        }
      }

      if (legacyJobs.length < 500 || transitioned === 0) return;
    }
  }

  private outputKey(
    userId: number,
    imageId: number,
    leaseToken: string,
    format: ImageFormat,
  ): string {
    return `images/${userId}/${imageId}-${leaseToken}.${format}`;
  }

  private integerConfig(
    key: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    const configured = Number(this.configService.get(key, fallback));
    if (!Number.isFinite(configured)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.trunc(configured)));
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
