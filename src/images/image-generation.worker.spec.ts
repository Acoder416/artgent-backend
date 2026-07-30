import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { UsersService } from '../users/users.service';
import { MinioService } from '../upload/minio.service';
import { AiService } from './ai.service';
import { ImageGenerationWorker } from './image-generation.worker';
import { Image } from './image.entity';

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Condition was not reached');
}

function pendingImage(id: number): Image {
  return Object.assign(new Image(), {
    id,
    userId: 7,
    requestId: 'request-1',
    prompt: `Prompt ${id}`,
    model: 'gpt-image-2',
    lineId: 'line-a',
    width: 1024,
    height: 1024,
    status: 'pending',
    jobVersion: 1,
    attemptCount: 0,
    availableAt: new Date(0),
    leaseToken: null,
    leaseExpiresAt: null,
    inputReferences: [],
  });
}

interface WorkerInternals {
  processJob(imageId: number): Promise<void>;
  scanForWork(): Promise<void>;
  cleanupInputObjectsAfterTerminal(image: Image): Promise<void>;
  reconcileInputCleanup(): Promise<void>;
}

function internals(worker: ImageGenerationWorker): WorkerInternals {
  return worker as unknown as WorkerInternals;
}

function statefulRepository(row: Image): Repository<Image> {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(({ where }: { where: { id: number } }) =>
      Promise.resolve(
        where.id === row.id ? Object.assign(new Image(), row) : null,
      ),
    ),
    update: jest.fn(
      (
        criteria: Partial<Image>,
        changes: Partial<Image>,
      ): Promise<{ affected: number }> => {
        const expiryGuard = criteria.leaseExpiresAt as
          | { type?: string; value?: Date }
          | undefined;
        if (
          expiryGuard?.type === 'moreThan' &&
          expiryGuard.value instanceof Date &&
          (!(row.leaseExpiresAt instanceof Date) ||
            row.leaseExpiresAt <= expiryGuard.value)
        ) {
          return Promise.resolve({ affected: 0 });
        }
        if (
          criteria.id !== row.id ||
          (criteria.status && criteria.status !== row.status) ||
          (typeof criteria.leaseToken === 'string' &&
            criteria.leaseToken !== row.leaseToken)
        ) {
          return Promise.resolve({ affected: 0 });
        }
        Object.assign(row, changes);
        return Promise.resolve({ affected: 1 });
      },
    ),
  } as unknown as Repository<Image>;
}

function successfulImageResult() {
  return {
    success: true as const,
    imageBuffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    imageFormat: 'png' as const,
    mimeType: 'image/png',
  };
}

function storedImage(key: string) {
  return {
    key,
    url: 'https://static.example.com/artgen/' + key,
    imageFormat: 'png' as const,
    mimeType: 'image/png',
  };
}

describe('ImageGenerationWorker concurrency', () => {
  it('uses 10 workers by default', () => {
    const worker = new ImageGenerationWorker(
      {} as Repository<Image>,
      {} as AiService,
      {} as MinioService,
      {} as UsersService,
      new ConfigService(),
    );

    expect((worker as unknown as { concurrency: number }).concurrency).toBe(10);
  });

  it('never exceeds the configured provider concurrency', async () => {
    const rows = [1, 2, 3, 4, 5].map(pendingImage);
    const repository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(({ where }: { where: { id: number } }) =>
        Promise.resolve(rows.find((row) => row.id === where.id) || null),
      ),
      update: jest.fn(
        (
          criteria: Partial<Image>,
          changes: Partial<Image>,
        ): Promise<{ affected: number }> => {
          const row = rows.find(
            (candidate) =>
              candidate.id === criteria.id &&
              (!criteria.status || candidate.status === criteria.status) &&
              (!criteria.leaseToken ||
                candidate.leaseToken === criteria.leaseToken),
          );
          if (!row) return Promise.resolve({ affected: 0 });
          Object.assign(row, changes);
          return Promise.resolve({ affected: 1 });
        },
      ),
      increment: jest.fn(
        (criteria: Partial<Image>, _field: string, value: number) => {
          const row = rows.find(
            (candidate) =>
              candidate.id === criteria.id &&
              candidate.leaseToken === criteria.leaseToken,
          );
          if (row) row.attemptCount += value;
          return Promise.resolve({ affected: row ? 1 : 0 });
        },
      ),
    } as unknown as Repository<Image>;

    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const ai = {
      generateImage: jest.fn(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return {
          success: true,
          imageBuffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          imageFormat: 'png',
          mimeType: 'image/png',
        };
      }),
    } as unknown as AiService;
    const minio = {
      statImage: jest.fn().mockResolvedValue(null),
      storeImage: jest.fn(
        (_buffer: Buffer, _userId: number, options: { key: string }) =>
          Promise.resolve({
            key: options.key,
            url: `https://static.example.com/artgen/${options.key}`,
            imageFormat: 'png',
            mimeType: 'image/png',
          }),
      ),
    } as unknown as MinioService;
    const worker = new ImageGenerationWorker(
      repository,
      ai,
      minio,
      {
        refundCreditsOnce: jest.fn(),
      } as unknown as UsersService,
      new ConfigService({
        IMAGE_WORKER_CONCURRENCY: 2,
        IMAGE_QUEUE_POLL_INTERVAL_MS: 60000,
      }),
    );

    await worker.onApplicationBootstrap();
    worker.wake(rows.map((row) => row.id));

    await waitUntil(() => releases.length === 2);
    expect(maximumActive).toBe(2);

    while (rows.some((row) => row.status !== 'completed')) {
      releases.splice(0).forEach((release) => release());
      await waitUntil(
        () =>
          rows.every((row) => row.status === 'completed') ||
          releases.length > 0,
      );
    }

    expect(maximumActive).toBe(2);
    expect(rows.every((row) => row.status === 'completed')).toBe(true);
    await worker.onApplicationShutdown();
  });
  it('reclaims an expired job and restores uploaded reference files', async () => {
    const row = pendingImage(9);
    row.status = 'generating';
    row.attemptCount = 1;
    row.leaseToken = 'expired-lease';
    row.leaseExpiresAt = new Date(0);
    row.inputReferences = [
      {
        kind: 'object',
        key: 'job-inputs/7/request-1/reference.png',
        url: 'https://static.example.com/artgen/job-inputs/7/request-1/reference.png',
        mimeType: 'image/png',
        originalName: 'reference.png',
      },
    ];
    const repository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest
        .fn()
        .mockImplementation(({ where }: { where: { id: number } }) =>
          Promise.resolve(where.id === row.id ? row : null),
        ),
      update: jest.fn(
        (
          criteria: Partial<Image>,
          changes: Partial<Image>,
        ): Promise<{ affected: number }> => {
          if (
            criteria.id !== row.id ||
            (criteria.status && criteria.status !== row.status) ||
            (criteria.leaseToken && criteria.leaseToken !== row.leaseToken)
          ) {
            return Promise.resolve({ affected: 0 });
          }
          Object.assign(row, changes);
          return Promise.resolve({ affected: 1 });
        },
      ),
      increment: jest.fn(
        (_criteria: Partial<Image>, _field: string, value: number) => {
          row.attemptCount += value;
          return Promise.resolve({ affected: 1 });
        },
      ),
      count: jest.fn().mockResolvedValue(0),
    } as unknown as Repository<Image>;
    const generateImage = jest.fn().mockResolvedValue({
      success: true,
      imageBuffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      imageFormat: 'png',
      mimeType: 'image/png',
    });
    const ai = {
      generateImage,
    } as unknown as AiService;
    const readImage = jest
      .fn()
      .mockResolvedValue(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const minio = {
      readImage,
      statImage: jest.fn().mockResolvedValue(null),
      deleteImage: jest.fn().mockResolvedValue(undefined),
      storeImage: jest.fn(
        (_buffer: Buffer, _userId: number, options: { key: string }) =>
          Promise.resolve({
            key: options.key,
            url: `https://static.example.com/artgen/${options.key}`,
            imageFormat: 'png',
            mimeType: 'image/png',
          }),
      ),
    } as unknown as MinioService;
    const worker = new ImageGenerationWorker(
      repository,
      ai,
      minio,
      {
        refundCreditsOnce: jest.fn(),
      } as unknown as UsersService,
      new ConfigService({
        IMAGE_WORKER_CONCURRENCY: 1,
        IMAGE_QUEUE_POLL_INTERVAL_MS: 60000,
      }),
    );

    await worker.onApplicationBootstrap();
    worker.wake([row.id]);
    await waitUntil(() => row.status === 'completed');

    expect(row.attemptCount).toBe(2);
    expect(readImage).toHaveBeenCalledWith(
      'job-inputs/7/request-1/reference.png',
    );
    expect(generateImage).toHaveBeenCalledWith(
      row.prompt,
      row.model,
      '1024x1024',
      expect.objectContaining({
        files: [
          expect.objectContaining({
            originalname: 'reference.png',
            mimetype: 'image/png',
          }),
        ],
      }),
      row.lineId,
    );
    await worker.onApplicationShutdown();
  });

  it('does not upload after losing the lease while reserving the output key', async () => {
    const row = pendingImage(12);
    let reservedKey: string | null = null;
    let claimedLeaseToken: string | null = null;
    const repository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(({ where }: { where: { id: number } }) =>
        Promise.resolve(where.id === row.id ? row : null),
      ),
      update: jest.fn(
        (
          criteria: Partial<Image>,
          changes: Partial<Image>,
        ): Promise<{ affected: number }> => {
          if (changes.imageKey && changes.status === undefined) {
            reservedKey = changes.imageKey;
            claimedLeaseToken = row.leaseToken;
            row.leaseToken = 'replacement-lease';
            return Promise.resolve({ affected: 0 });
          }
          if (
            criteria.id !== row.id ||
            (criteria.status && criteria.status !== row.status) ||
            (criteria.leaseToken && criteria.leaseToken !== row.leaseToken)
          ) {
            return Promise.resolve({ affected: 0 });
          }
          Object.assign(row, changes);
          return Promise.resolve({ affected: 1 });
        },
      ),
      increment: jest.fn(
        (_criteria: Partial<Image>, _field: string, value: number) => {
          row.attemptCount += value;
          return Promise.resolve({ affected: 1 });
        },
      ),
      count: jest.fn().mockResolvedValue(0),
    } as unknown as Repository<Image>;
    const ai = {
      generateImage: jest.fn().mockResolvedValue({
        success: true,
        imageBuffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        imageFormat: 'png',
        mimeType: 'image/png',
      }),
    } as unknown as AiService;
    const storeImage = jest.fn();
    const worker = new ImageGenerationWorker(
      repository,
      ai,
      {
        statImage: jest.fn().mockResolvedValue(null),
        storeImage,
      } as unknown as MinioService,
      { refundCreditsOnce: jest.fn() } as unknown as UsersService,
      new ConfigService({ IMAGE_QUEUE_POLL_INTERVAL_MS: 60000 }),
    );

    await worker.onApplicationBootstrap();
    worker.wake([row.id]);
    await waitUntil(() => reservedKey !== null);
    await worker.onApplicationShutdown();

    expect(reservedKey).toContain(claimedLeaseToken);
    expect(storeImage).not.toHaveBeenCalled();
  });

  it('recovers the output from the persisted lease-scoped image key first', async () => {
    const row = pendingImage(13);
    const persistedKey = 'images/7/13-11111111-1111-4111-8111-111111111111.png';
    row.status = 'generating';
    row.attemptCount = 1;
    row.leaseToken = 'expired-lease';
    row.leaseExpiresAt = new Date(0);
    row.imageKey = persistedKey;
    const repository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(({ where }: { where: { id: number } }) =>
        Promise.resolve(where.id === row.id ? row : null),
      ),
      update: jest.fn(
        (
          criteria: Partial<Image>,
          changes: Partial<Image>,
        ): Promise<{ affected: number }> => {
          if (
            criteria.id !== row.id ||
            (criteria.status && criteria.status !== row.status) ||
            (criteria.leaseToken && criteria.leaseToken !== row.leaseToken)
          ) {
            return Promise.resolve({ affected: 0 });
          }
          Object.assign(row, changes);
          return Promise.resolve({ affected: 1 });
        },
      ),
      increment: jest.fn(
        (_criteria: Partial<Image>, _field: string, value: number) => {
          row.attemptCount += value;
          return Promise.resolve({ affected: 1 });
        },
      ),
      count: jest.fn().mockResolvedValue(0),
    } as unknown as Repository<Image>;
    const generateImage = jest.fn();
    const statImage = jest.fn((key: string) =>
      Promise.resolve(
        key === persistedKey
          ? {
              key: persistedKey,
              url: 'https://static.example.com/artgen/' + persistedKey,
              imageFormat: 'png',
              mimeType: 'image/png',
            }
          : null,
      ),
    );
    const worker = new ImageGenerationWorker(
      repository,
      { generateImage } as unknown as AiService,
      {
        statImage,
        storeImage: jest.fn(),
        deleteImage: jest.fn(),
      } as unknown as MinioService,
      { refundCreditsOnce: jest.fn() } as unknown as UsersService,
      new ConfigService({ IMAGE_QUEUE_POLL_INTERVAL_MS: 60000 }),
    );

    await worker.onApplicationBootstrap();
    worker.wake([row.id]);
    await waitUntil(() => row.status === 'completed');
    await worker.onApplicationShutdown();

    expect(statImage.mock.calls[0][0]).toBe(persistedKey);
    expect(generateImage).not.toHaveBeenCalled();
    expect(row.imageKey).toBe(persistedKey);
  });

  it('cleans staged input objects after the last job completes', async () => {
    const row = pendingImage(14);
    const inputKey = 'job-inputs/7/request-1/reference.png';
    row.inputReferences = [
      {
        kind: 'object',
        key: inputKey,
        url: 'https://static.example.com/artgen/' + inputKey,
        mimeType: 'image/png',
        originalName: 'reference.png',
      },
    ];
    const repository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(({ where }: { where: { id: number } }) =>
        Promise.resolve(where.id === row.id ? row : null),
      ),
      update: jest.fn(
        (
          criteria: Partial<Image>,
          changes: Partial<Image>,
        ): Promise<{ affected: number }> => {
          if (
            criteria.id !== row.id ||
            (criteria.status && criteria.status !== row.status) ||
            (criteria.leaseToken && criteria.leaseToken !== row.leaseToken)
          ) {
            return Promise.resolve({ affected: 0 });
          }
          Object.assign(row, changes);
          return Promise.resolve({ affected: 1 });
        },
      ),
      increment: jest.fn(
        (_criteria: Partial<Image>, _field: string, value: number) => {
          row.attemptCount += value;
          return Promise.resolve({ affected: 1 });
        },
      ),
      count: jest.fn().mockResolvedValue(0),
    } as unknown as Repository<Image>;
    const deleteImage = jest.fn().mockResolvedValue(undefined);
    const worker = new ImageGenerationWorker(
      repository,
      {
        generateImage: jest.fn().mockResolvedValue({
          success: true,
          imageBuffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          imageFormat: 'png',
          mimeType: 'image/png',
        }),
      } as unknown as AiService,
      {
        readImage: jest
          .fn()
          .mockResolvedValue(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
        statImage: jest.fn().mockResolvedValue(null),
        storeImage: jest.fn(
          (_buffer: Buffer, _userId: number, options: { key: string }) =>
            Promise.resolve({
              key: options.key,
              url: 'https://static.example.com/artgen/' + options.key,
              imageFormat: 'png',
              mimeType: 'image/png',
            }),
        ),
        deleteImage,
      } as unknown as MinioService,
      { refundCreditsOnce: jest.fn() } as unknown as UsersService,
      new ConfigService({ IMAGE_QUEUE_POLL_INTERVAL_MS: 60000 }),
    );

    await worker.onApplicationBootstrap();
    worker.wake([row.id]);
    await waitUntil(() => row.status === 'completed');
    await worker.onApplicationShutdown();

    expect(deleteImage).toHaveBeenCalledWith(inputKey);
  });

  it('keeps a final failure and refund when staged input cleanup fails', async () => {
    const row = pendingImage(15);
    const inputKey = 'job-inputs/7/request-1/reference.png';
    row.inputReferences = [
      {
        kind: 'object',
        key: inputKey,
        url: 'https://static.example.com/artgen/' + inputKey,
        mimeType: 'image/png',
        originalName: 'reference.png',
      },
    ];
    const repository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(({ where }: { where: { id: number } }) =>
        Promise.resolve(where.id === row.id ? row : null),
      ),
      update: jest.fn(
        (
          criteria: Partial<Image>,
          changes: Partial<Image>,
        ): Promise<{ affected: number }> => {
          if (
            criteria.id !== row.id ||
            (criteria.status && criteria.status !== row.status) ||
            (typeof criteria.leaseToken === 'string' &&
              criteria.leaseToken !== row.leaseToken)
          ) {
            return Promise.resolve({ affected: 0 });
          }
          Object.assign(row, changes);
          return Promise.resolve({ affected: 1 });
        },
      ),
      increment: jest.fn(
        (_criteria: Partial<Image>, _field: string, value: number) => {
          row.attemptCount += value;
          return Promise.resolve({ affected: 1 });
        },
      ),
      count: jest.fn().mockResolvedValue(0),
    } as unknown as Repository<Image>;
    const deleteImage = jest
      .fn()
      .mockRejectedValue(new Error('temporary MinIO failure'));
    const refundCreditsOnce = jest.fn().mockResolvedValue(undefined);
    const worker = new ImageGenerationWorker(
      repository,
      {
        generateImage: jest.fn().mockResolvedValue({
          success: false,
          error: 'provider rejected the request',
          retryable: false,
        }),
      } as unknown as AiService,
      {
        readImage: jest
          .fn()
          .mockResolvedValue(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
        statImage: jest.fn().mockResolvedValue(null),
        deleteImage,
      } as unknown as MinioService,
      { refundCreditsOnce } as unknown as UsersService,
      new ConfigService({ IMAGE_QUEUE_POLL_INTERVAL_MS: 60000 }),
    );

    await worker.onApplicationBootstrap();
    worker.wake([row.id]);
    await waitUntil(() => row.status === 'failed' && row.refundedAt != null);
    await worker.onApplicationShutdown();

    expect(deleteImage).toHaveBeenCalledWith(inputKey);
    expect(refundCreditsOnce).toHaveBeenCalledWith(
      row.userId,
      1,
      'request-1:15',
      expect.any(String),
    );
    expect(row.status).toBe('failed');
  });

  it('does not refund legacy failures settled by the synchronous worker', async () => {
    const row = pendingImage(16);
    row.jobVersion = 0;
    row.status = 'failed';
    row.refundedAt = null;
    const repository = {
      find: jest.fn(
        ({ where }: { where: Partial<Image> | Partial<Image>[] }) => {
          if (Array.isArray(where)) return Promise.resolve([]);
          if (
            where.status === 'failed' &&
            (where.jobVersion === undefined ||
              where.jobVersion === row.jobVersion) &&
            row.refundedAt === null
          ) {
            return Promise.resolve([row]);
          }
          return Promise.resolve([]);
        },
      ),
      update: jest.fn(
        (
          criteria: Partial<Image>,
          changes: Partial<Image>,
        ): Promise<{ affected: number }> => {
          if (
            criteria.id !== row.id ||
            (criteria.status && criteria.status !== row.status)
          ) {
            return Promise.resolve({ affected: 0 });
          }
          Object.assign(row, changes);
          return Promise.resolve({ affected: 1 });
        },
      ),
    } as unknown as Repository<Image>;
    const refundCreditsOnce = jest.fn().mockResolvedValue(undefined);
    const worker = new ImageGenerationWorker(
      repository,
      {} as AiService,
      {} as MinioService,
      { refundCreditsOnce } as unknown as UsersService,
      new ConfigService({ IMAGE_QUEUE_POLL_INTERVAL_MS: 60000 }),
    );

    await worker.onApplicationBootstrap();
    await worker.onApplicationShutdown();

    expect(refundCreditsOnce).not.toHaveBeenCalled();
    expect(row.refundedAt).toBeNull();
  });

  it('finishes every legacy job when more than one recovery batch exists', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => {
      const row = pendingImage(1_000 + index);
      row.jobVersion = 0;
      row.status = 'generating';
      row.refundedAt = null;
      return row;
    });
    const repository = {
      find: jest.fn(
        ({
          where,
          take,
        }: {
          where: Partial<Image> | Partial<Image>[];
          take?: number;
        }) => {
          if (Array.isArray(where)) return Promise.resolve([]);
          if (where.status === 'generating' && where.jobVersion === 0) {
            return Promise.resolve(
              rows
                .filter(
                  (row) => row.status === 'generating' && row.jobVersion === 0,
                )
                .slice(0, take),
            );
          }
          if (where.status === 'failed') {
            return Promise.resolve(
              rows
                .filter(
                  (row) => row.status === 'failed' && row.refundedAt === null,
                )
                .slice(0, take),
            );
          }
          return Promise.resolve([]);
        },
      ),
      update: jest.fn(
        (
          criteria: Partial<Image>,
          changes: Partial<Image>,
        ): Promise<{ affected: number }> => {
          const row = rows.find((candidate) => candidate.id === criteria.id);
          if (
            !row ||
            (criteria.status && criteria.status !== row.status) ||
            (criteria.jobVersion !== undefined &&
              criteria.jobVersion !== row.jobVersion) ||
            (criteria.refundedAt !== undefined && row.refundedAt !== null)
          ) {
            return Promise.resolve({ affected: 0 });
          }
          Object.assign(row, changes);
          return Promise.resolve({ affected: 1 });
        },
      ),
    } as unknown as Repository<Image>;
    const refundCreditsOnce = jest.fn().mockResolvedValue(undefined);
    const worker = new ImageGenerationWorker(
      repository,
      {} as AiService,
      {} as MinioService,
      { refundCreditsOnce } as unknown as UsersService,
      new ConfigService({ IMAGE_QUEUE_POLL_INTERVAL_MS: 60000 }),
    );

    await worker.onApplicationBootstrap();
    await worker.onApplicationShutdown();

    expect(rows.every((row) => row.status === 'failed')).toBe(true);
    expect(rows.every((row) => row.refundedAt instanceof Date)).toBe(true);
    expect(refundCreditsOnce).toHaveBeenCalledTimes(501);
  });

  it('does not upload when the lease expires before reserving the output key', async () => {
    const row = pendingImage(18);
    const repository = statefulRepository(row);
    const storeImage = jest.fn(
      (_buffer: Buffer, _userId: number, options: { key: string }) =>
        Promise.resolve(storedImage(options.key)),
    );
    const worker = new ImageGenerationWorker(
      repository,
      {
        generateImage: jest.fn().mockImplementation(() => {
          row.leaseExpiresAt = new Date(0);
          return Promise.resolve(successfulImageResult());
        }),
      } as unknown as AiService,
      {
        statImage: jest.fn().mockResolvedValue(null),
        storeImage,
      } as unknown as MinioService,
      { refundCreditsOnce: jest.fn() } as unknown as UsersService,
      new ConfigService(),
    );

    await internals(worker).processJob(row.id);

    const reserveCall = (
      repository.update as jest.MockedFunction<Repository<Image>['update']>
    ).mock.calls.find(([, changes]) => changes.imageKey);
    const reserveCriteria = reserveCall?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(reserveCriteria).toMatchObject({
      id: row.id,
      status: 'generating',
    });
    expect(typeof reserveCriteria?.leaseToken).toBe('string');
    expect(reserveCriteria?.leaseExpiresAt).toMatchObject({
      type: 'moreThan',
    });
    expect(storeImage).not.toHaveBeenCalled();
  });

  it('deletes a stale upload when a successor lease has changed the output key', async () => {
    const row = pendingImage(19);
    const repository = statefulRepository(row);
    const deleteImage = jest
      .fn()
      .mockRejectedValueOnce(new Error('temporary MinIO failure'))
      .mockResolvedValue(undefined);
    let uploadedKey = '';
    const successorKey = 'images/7/19-successor.png';
    const worker = new ImageGenerationWorker(
      repository,
      {
        generateImage: jest.fn().mockResolvedValue(successfulImageResult()),
      } as unknown as AiService,
      {
        statImage: jest.fn().mockResolvedValue(null),
        storeImage: jest.fn(
          (_buffer: Buffer, _userId: number, options: { key: string }) => {
            uploadedKey = options.key;
            row.leaseToken = 'successor-lease';
            row.imageKey = successorKey;
            return Promise.resolve(storedImage(options.key));
          },
        ),
        deleteImage,
      } as unknown as MinioService,
      { refundCreditsOnce: jest.fn() } as unknown as UsersService,
      new ConfigService(),
    );

    await internals(worker).processJob(row.id);

    expect(uploadedKey).not.toBe('');
    expect(row.imageKey).toBe(successorKey);
    expect(deleteImage).toHaveBeenCalledWith(uploadedKey);
    expect(deleteImage).toHaveBeenCalledTimes(1);
    await internals(worker).scanForWork();
    expect(deleteImage).toHaveBeenCalledTimes(2);
    expect(deleteImage).toHaveBeenLastCalledWith(uploadedKey);
  });

  it('keeps a stale upload when the successor lease still references its key', async () => {
    const row = pendingImage(20);
    const repository = statefulRepository(row);
    const deleteImage = jest.fn().mockResolvedValue(undefined);
    let uploadedKey = '';
    const worker = new ImageGenerationWorker(
      repository,
      {
        generateImage: jest.fn().mockResolvedValue(successfulImageResult()),
      } as unknown as AiService,
      {
        statImage: jest.fn().mockResolvedValue(null),
        storeImage: jest.fn(
          (_buffer: Buffer, _userId: number, options: { key: string }) => {
            uploadedKey = options.key;
            row.leaseToken = 'successor-lease';
            return Promise.resolve(storedImage(options.key));
          },
        ),
        deleteImage,
      } as unknown as MinioService,
      { refundCreditsOnce: jest.fn() } as unknown as UsersService,
      new ConfigService(),
    );

    await internals(worker).processJob(row.id);

    expect(row.imageKey).toBe(uploadedKey);
    expect(deleteImage).not.toHaveBeenCalled();
  });

  it('deletes a stale upload when the successor has already failed', async () => {
    const row = pendingImage(25);
    const repository = statefulRepository(row);
    const deleteImage = jest.fn().mockResolvedValue(undefined);
    let uploadedKey = '';
    const worker = new ImageGenerationWorker(
      repository,
      {
        generateImage: jest.fn().mockResolvedValue(successfulImageResult()),
      } as unknown as AiService,
      {
        statImage: jest.fn().mockResolvedValue(null),
        storeImage: jest.fn(
          (_buffer: Buffer, _userId: number, options: { key: string }) => {
            uploadedKey = options.key;
            row.status = 'failed';
            row.leaseToken = null;
            return Promise.resolve(storedImage(options.key));
          },
        ),
        deleteImage,
      } as unknown as MinioService,
      { refundCreditsOnce: jest.fn() } as unknown as UsersService,
      new ConfigService(),
    );

    await internals(worker).processJob(row.id);

    expect(row.status).toBe('failed');
    expect(row.imageKey).toBe(uploadedKey);
    expect(deleteImage).toHaveBeenCalledWith(uploadedKey);
  });

  it('cleans shared staged inputs only after every sibling is terminal', async () => {
    const inputKey = 'job-inputs/7/request-1/reference.png';
    const inputReference: Image['inputReferences'] = [
      {
        kind: 'object',
        key: inputKey,
        url: 'https://static.example.com/artgen/' + inputKey,
        mimeType: 'image/png',
        originalName: 'reference.png',
      },
    ];
    const first = pendingImage(21);
    const second = pendingImage(24);
    first.inputReferences = inputReference;
    second.inputReferences = inputReference;
    const rows = [first, second];
    const findOne = jest.fn(({ where }: { where: { id: number } }) => {
      const row = rows.find((candidate) => candidate.id === where.id);
      return Promise.resolve(row ? Object.assign(new Image(), row) : null);
    });
    const find = jest.fn(
      ({ where }: { where: Partial<Image> | Partial<Image>[] }) => {
        const isCleanupScan =
          Array.isArray(where) &&
          where.some((criteria) =>
            Object.prototype.hasOwnProperty.call(criteria, 'inputReferences'),
          );
        if (!isCleanupScan) return Promise.resolve([]);
        return Promise.resolve(
          rows
            .filter(
              (row) =>
                (row.status === 'completed' || row.status === 'failed') &&
                row.inputReferences != null,
            )
            .map((row) => Object.assign(new Image(), row)),
        );
      },
    );
    const update = jest.fn(
      (
        criteria: Partial<Image>,
        changes: Partial<Image>,
      ): Promise<{ affected: number }> => {
        const row = rows.find((candidate) => candidate.id === criteria.id);
        if (!row) return Promise.resolve({ affected: 0 });
        const expiryGuard = criteria.leaseExpiresAt as
          | { type?: string; value?: Date }
          | undefined;
        if (
          expiryGuard?.type === 'moreThan' &&
          expiryGuard.value instanceof Date &&
          (!(row.leaseExpiresAt instanceof Date) ||
            row.leaseExpiresAt <= expiryGuard.value)
        ) {
          return Promise.resolve({ affected: 0 });
        }
        if (
          (criteria.status && criteria.status !== row.status) ||
          (typeof criteria.leaseToken === 'string' &&
            criteria.leaseToken !== row.leaseToken)
        ) {
          return Promise.resolve({ affected: 0 });
        }
        Object.assign(row, changes);
        return Promise.resolve({ affected: 1 });
      },
    );
    const count = jest.fn(() =>
      Promise.resolve(
        rows.filter(
          (row) => row.status === 'pending' || row.status === 'generating',
        ).length,
      ),
    );
    const repository = {
      find,
      findOne,
      update,
      count,
    } as unknown as Repository<Image>;
    const deleteImage = jest.fn().mockResolvedValue(undefined);
    const worker = new ImageGenerationWorker(
      repository,
      {
        generateImage: jest.fn().mockResolvedValue(successfulImageResult()),
      } as unknown as AiService,
      {
        readImage: jest
          .fn()
          .mockResolvedValue(successfulImageResult().imageBuffer),
        statImage: jest.fn().mockResolvedValue(null),
        storeImage: jest.fn(
          (_buffer: Buffer, _userId: number, options: { key: string }) =>
            Promise.resolve(storedImage(options.key)),
        ),
        deleteImage,
      } as unknown as MinioService,
      {} as UsersService,
      new ConfigService(),
    );

    await internals(worker).processJob(first.id);
    expect(first.status).toBe('completed');
    expect(first.inputReferences).not.toBeNull();
    expect(second.status).toBe('pending');
    expect(deleteImage).not.toHaveBeenCalled();

    await internals(worker).processJob(second.id);
    expect(second.status).toBe('completed');
    expect(second.inputReferences).toBeNull();
    expect(deleteImage).toHaveBeenCalledTimes(1);

    await internals(worker).scanForWork();
    expect(first.inputReferences).toBeNull();
    expect(deleteImage).toHaveBeenCalledTimes(2);
  });

  it('advances cleanup past a full page waiting for active siblings', async () => {
    const blockedRows = Array.from({ length: 50 }, (_, index) => {
      const row = pendingImage(2_000 + index);
      row.status = 'completed';
      row.requestId = `blocked-${row.id}`;
      row.inputReferences = [
        {
          kind: 'object',
          key: `job-inputs/7/${row.requestId}/reference.png`,
          url: `https://static.example.com/artgen/job-inputs/7/${row.requestId}/reference.png`,
          mimeType: 'image/png',
          originalName: 'reference.png',
        },
      ];
      return row;
    });
    const lateRow = pendingImage(3_000);
    lateRow.status = 'failed';
    lateRow.requestId = 'ready-for-cleanup';
    const lateKey = 'job-inputs/7/ready-for-cleanup/reference.png';
    lateRow.inputReferences = [
      {
        kind: 'object',
        key: lateKey,
        url: 'https://static.example.com/artgen/' + lateKey,
        mimeType: 'image/png',
        originalName: 'reference.png',
      },
    ];
    let secondWhere: Partial<Image>[] | undefined;
    const find = jest
      .fn()
      .mockResolvedValueOnce(blockedRows)
      .mockImplementationOnce(
        ({ where }: { where: Partial<Image> | Partial<Image>[] }) => {
          secondWhere = Array.isArray(where) ? where : undefined;
          return Promise.resolve([lateRow]);
        },
      );
    const update = jest.fn(
      (
        criteria: Partial<Image>,
        changes: Partial<Image>,
      ): Promise<{ affected: number }> => {
        if (criteria.id !== lateRow.id) {
          return Promise.resolve({ affected: 0 });
        }
        Object.assign(lateRow, changes);
        return Promise.resolve({ affected: 1 });
      },
    );
    const repository = {
      find,
      count: jest.fn(({ where }: { where: Array<{ requestId: string }> }) =>
        Promise.resolve(where[0].requestId === lateRow.requestId ? 0 : 1),
      ),
      update,
    } as unknown as Repository<Image>;
    const deleteImage = jest.fn().mockResolvedValue(undefined);
    const worker = new ImageGenerationWorker(
      repository,
      {} as AiService,
      { deleteImage } as unknown as MinioService,
      {} as UsersService,
      new ConfigService(),
    );

    await internals(worker).reconcileInputCleanup();
    expect(deleteImage).not.toHaveBeenCalled();

    await internals(worker).reconcileInputCleanup();

    const cursor = secondWhere?.[0].id as unknown as
      | { type?: unknown; value?: unknown }
      | undefined;
    expect(cursor?.type).toBe('moreThan');
    expect(cursor?.value).toBe(blockedRows[blockedRows.length - 1].id);
    expect(deleteImage).toHaveBeenCalledWith(lateKey);
    expect(lateRow.inputReferences).toBeNull();
  });

  it('deletes a missing persisted output when a new lease supersedes its key', async () => {
    const row = pendingImage(23);
    const previousKey = 'images/7/23-previous-lease.png';
    row.imageKey = previousKey;
    const repository = statefulRepository(row);
    const deleteImage = jest.fn().mockResolvedValue(undefined);
    const worker = new ImageGenerationWorker(
      repository,
      {
        generateImage: jest.fn().mockResolvedValue(successfulImageResult()),
      } as unknown as AiService,
      {
        statImage: jest.fn().mockResolvedValue(null),
        storeImage: jest.fn(
          (_buffer: Buffer, _userId: number, options: { key: string }) =>
            Promise.resolve(storedImage(options.key)),
        ),
        deleteImage,
      } as unknown as MinioService,
      { refundCreditsOnce: jest.fn() } as unknown as UsersService,
      new ConfigService(),
    );

    await internals(worker).processJob(row.id);

    expect(row.status).toBe('completed');
    expect(row.imageKey).not.toBe(previousKey);
    expect(deleteImage).toHaveBeenCalledWith(previousKey);
  });

  it('retries persisted staged-input cleanup after a transient failure', async () => {
    const row = pendingImage(22);
    row.status = 'failed';
    row.inputReferences = [
      {
        kind: 'object',
        key: 'job-inputs/7/request-1/reference.png',
        url: 'https://static.example.com/artgen/job-inputs/7/request-1/reference.png',
        mimeType: 'image/png',
        originalName: 'reference.png',
      },
    ];
    const repository = {
      find: jest.fn(
        ({ where }: { where: Partial<Image> | Partial<Image>[] }) => {
          if (
            Array.isArray(where) &&
            where.some((criteria) => criteria.status === 'completed')
          ) {
            return Promise.resolve(row.inputReferences ? [row] : []);
          }
          return Promise.resolve([]);
        },
      ),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(
        (
          criteria: Partial<Image>,
          changes: Partial<Image>,
        ): Promise<{ affected: number }> => {
          if (criteria.id !== row.id) return Promise.resolve({ affected: 0 });
          Object.assign(row, changes);
          return Promise.resolve({ affected: 1 });
        },
      ),
    } as unknown as Repository<Image>;
    const deleteImage = jest
      .fn()
      .mockRejectedValueOnce(new Error('temporary MinIO failure'))
      .mockResolvedValue(undefined);
    const worker = new ImageGenerationWorker(
      repository,
      {} as AiService,
      { deleteImage } as unknown as MinioService,
      {} as UsersService,
      new ConfigService(),
    );

    await internals(worker).cleanupInputObjectsAfterTerminal(row);
    expect(row.inputReferences).not.toBeNull();

    await internals(worker).scanForWork();

    expect(deleteImage).toHaveBeenCalledTimes(2);
    expect(row.inputReferences).toBeNull();
  });

  it('waits for an in-flight queue scan during shutdown', async () => {
    let releaseScan: (() => void) | undefined;
    let scanStarted = false;
    const repository = {
      find: jest
        .fn()
        .mockResolvedValue([])
        .mockImplementationOnce(
          () =>
            new Promise<Image[]>((resolve) => {
              scanStarted = true;
              releaseScan = () => resolve([]);
            }),
        ),
    } as unknown as Repository<Image>;
    const worker = new ImageGenerationWorker(
      repository,
      {} as AiService,
      {} as MinioService,
      {} as UsersService,
      new ConfigService({ IMAGE_WORKER_SHUTDOWN_GRACE_MS: 10_000 }),
    );

    const scan = internals(worker).scanForWork();
    await waitUntil(() => scanStarted);
    let shutdownFinished = false;
    const shutdown = worker.onApplicationShutdown().then(() => {
      shutdownFinished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(shutdownFinished).toBe(false);
    expect(releaseScan).toBeDefined();
    releaseScan?.();
    await scan;
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });

  it('requeues a transient provider failure without refunding it', async () => {
    const row = pendingImage(17);
    const repository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(({ where }: { where: { id: number } }) =>
        Promise.resolve(where.id === row.id ? row : null),
      ),
      update: jest.fn(
        (
          criteria: Partial<Image>,
          changes: Partial<Image>,
        ): Promise<{ affected: number }> => {
          if (
            criteria.id !== row.id ||
            (criteria.status && criteria.status !== row.status) ||
            (typeof criteria.leaseToken === 'string' &&
              criteria.leaseToken !== row.leaseToken)
          ) {
            return Promise.resolve({ affected: 0 });
          }
          Object.assign(row, changes);
          return Promise.resolve({ affected: 1 });
        },
      ),
    } as unknown as Repository<Image>;
    const generateImage = jest.fn().mockResolvedValue({
      success: false,
      error: 'socket disconnected',
      retryable: true,
    });
    const refundCreditsOnce = jest.fn();
    const worker = new ImageGenerationWorker(
      repository,
      { generateImage } as unknown as AiService,
      {
        statImage: jest.fn().mockResolvedValue(null),
      } as unknown as MinioService,
      { refundCreditsOnce } as unknown as UsersService,
      new ConfigService({
        IMAGE_WORKER_CONCURRENCY: 1,
        IMAGE_QUEUE_POLL_INTERVAL_MS: 60000,
      }),
    );

    await worker.onApplicationBootstrap();
    worker.wake([row.id]);
    await waitUntil(
      () =>
        generateImage.mock.calls.length === 1 &&
        row.status === 'pending' &&
        row.attemptCount === 1,
    );
    await worker.onApplicationShutdown();

    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.errorMessage).toBe('socket disconnected');
    expect(row.refundedAt).toBeFalsy();
    expect(refundCreditsOnce).not.toHaveBeenCalled();
  });
});
