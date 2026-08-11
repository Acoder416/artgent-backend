import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { MinioService } from '../upload/minio.service';
import { UsersService } from '../users/users.service';
import { AiService } from './ai.service';
import { ImageGenerationWorker } from './image-generation.worker';
import { Image } from './image.entity';

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Condition was not reached');
}

function pendingImage(id: number, lineId: string): Image {
  return Object.assign(new Image(), {
    id,
    userId: 7,
    requestId: `request-${id}`,
    prompt: `Prompt ${id}`,
    model: 'gpt-image-2',
    quality: 'auto',
    lineId,
    width: 1024,
    height: 1024,
    status: 'pending',
    jobVersion: 1,
    attemptCount: 0,
    availableAt: new Date(0),
    leaseToken: null,
    leaseExpiresAt: null,
    inputReferences:
      lineId === 'line-a'
        ? [
            {
              kind: 'object' as const,
              role: 'image' as const,
              key: `job-inputs/7/request-${id}/reference.png`,
              url: `https://static.example.com/reference-${id}.png`,
              mimeType: 'image/png' as const,
              originalName: `reference-${id}.png`,
            },
          ]
        : [],
  });
}

function matchesLineCriterion(criterion: unknown, lineId: string): boolean {
  if (criterion === undefined) return true;
  if (typeof criterion === 'string') return criterion === lineId;
  const operator = criterion as { _type?: string; _value?: unknown };
  if (operator?._type !== 'not') return false;
  const inner = operator._value as { _type?: string; _value?: unknown };
  return !(
    inner?._type === 'in' &&
    Array.isArray(inner._value) &&
    inner._value.includes(lineId)
  );
}

function queueRepository(rows: Image[]): Repository<Image> {
  return {
    find: jest.fn(
      ({
        where,
        take,
      }: {
        where: Partial<Image> | Partial<Image>[];
        take?: number;
      }) => {
        const criteria = Array.isArray(where) ? where : [where];
        const queueScan = criteria.some(
          (entry) => entry.jobVersion === 1 && entry.status === 'pending',
        );
        if (!queueScan) return Promise.resolve([]);
        return Promise.resolve(
          rows
            .filter(
              (row) =>
                row.status === 'pending' &&
                row.availableAt.getTime() <= Date.now() &&
                criteria.some((entry) =>
                  matchesLineCriterion(entry.lineId, row.lineId),
                ),
            )
            .slice(0, take),
        );
      },
    ),
    findOne: jest.fn(({ where }: { where: Partial<Image> }) => {
      const row = rows.find((candidate) => candidate.id === where.id);
      if (!row) return Promise.resolve(null);
      if (
        typeof where.leaseToken === 'string' &&
        where.leaseToken !== row.leaseToken
      ) {
        return Promise.resolve(null);
      }
      return Promise.resolve(Object.assign(new Image(), row));
    }),
    update: jest.fn(
      (
        criteria: Partial<Image>,
        changes: Partial<Image>,
      ): Promise<{ affected: number }> => {
        const row = rows.find((candidate) => candidate.id === criteria.id);
        if (
          !row ||
          (criteria.status !== undefined && criteria.status !== row.status) ||
          (criteria.attemptCount !== undefined &&
            criteria.attemptCount !== row.attemptCount) ||
          (typeof criteria.leaseToken === 'string' &&
            criteria.leaseToken !== row.leaseToken)
        ) {
          return Promise.resolve({ affected: 0 });
        }
        Object.assign(row, changes);
        return Promise.resolve({ affected: 1 });
      },
    ),
    count: jest.fn().mockResolvedValue(0),
  } as unknown as Repository<Image>;
}

describe('ImageGenerationWorker line-aware scheduling', () => {
  it('runs line-b behind a scan page of line-a jobs without loading blocked line-a inputs', async () => {
    const rows = [
      ...Array.from({ length: 60 }, (_, index) =>
        pendingImage(index + 1, 'line-a'),
      ),
      pendingImage(61, 'line-b'),
    ];
    const repository = queueRepository(rows);
    let activeLineA = 0;
    let maximumActiveLineA = 0;
    let lineBStarted = false;
    let releaseLineA!: () => void;
    const lineAGate = new Promise<void>((resolve) => {
      releaseLineA = resolve;
    });
    const generateImage = jest.fn(
      async (
        _prompt: string,
        _model: string,
        _size: string,
        _reference: unknown,
        lineId: string,
      ) => {
        if (lineId === 'line-a') {
          activeLineA += 1;
          maximumActiveLineA = Math.max(maximumActiveLineA, activeLineA);
          await lineAGate;
          activeLineA -= 1;
        } else {
          lineBStarted = true;
        }
        return {
          success: true as const,
          imageBuffer: Buffer.from('image'),
          imageFormat: 'png' as const,
          mimeType: 'image/png' as const,
          width: 3,
          height: 2,
        };
      },
    );
    const ai = {
      generateImage,
      listLines: () => ({
        defaultLineId: 'line-a',
        lines: [
          { id: 'line-a', name: '线路 A' },
          { id: 'line-b', name: '线路 B' },
        ],
      }),
      getLineMaxConcurrency: (lineId: string) => (lineId === 'line-a' ? 3 : 10),
    } as unknown as AiService;
    const readImage = jest.fn().mockResolvedValue(Buffer.from('reference'));
    const minio = {
      readImage,
      statImage: jest.fn().mockResolvedValue(null),
      storeImage: jest.fn(
        (_buffer: Buffer, _userId: number, options: { key: string }) =>
          Promise.resolve({
            key: options.key,
            url: `https://static.example.com/${options.key}`,
            imageFormat: 'png',
            mimeType: 'image/png',
          }),
      ),
      deleteImage: jest.fn().mockResolvedValue(undefined),
    } as unknown as MinioService;
    const worker = new ImageGenerationWorker(
      repository,
      ai,
      minio,
      { refundCreditsOnce: jest.fn() } as unknown as UsersService,
      new ConfigService({
        IMAGE_WORKER_CONCURRENCY: 10,
        IMAGE_QUEUE_POLL_INTERVAL_MS: 60_000,
      }),
    );

    try {
      await worker.onApplicationBootstrap();
      await waitUntil(() => maximumActiveLineA >= 3);
      for (let turn = 0; turn < 20; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      expect(lineBStarted).toBe(true);
      expect(maximumActiveLineA).toBe(3);
      expect(readImage).toHaveBeenCalledTimes(3);
    } finally {
      releaseLineA();
      await waitUntil(() => rows.every((row) => row.status === 'completed'));
      await worker.onApplicationShutdown();
    }

    expect(maximumActiveLineA).toBeLessThanOrEqual(3);
  });

  it('round-robins a newly freed global slot to a later line', async () => {
    const rows = [
      pendingImage(1, 'line-a'),
      pendingImage(2, 'line-a'),
      pendingImage(3, 'line-b'),
      pendingImage(4, 'retired-line'),
    ];
    rows.forEach((row) => {
      row.inputReferences = [];
    });
    const repository = queueRepository(rows);
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const ai = {
      listLines: () => ({
        defaultLineId: 'line-a',
        lines: [
          { id: 'line-a', name: '线路 A' },
          { id: 'line-b', name: '线路 B' },
        ],
      }),
      getLineMaxConcurrency: (lineId: string) => {
        if (lineId === 'line-a' || lineId === 'line-b') return 10;
        throw new Error(`Unknown AI line: ${lineId}`);
      },
      generateImage: jest.fn(
        async (
          _prompt: string,
          _model: string,
          _size: string,
          _reference: unknown,
          lineId: string,
        ) => {
          started.push(lineId);
          if (lineId !== 'retired-line') {
            await new Promise<void>((resolve) => releases.set(lineId, resolve));
          }
          return {
            success: false as const,
            error: `stop ${lineId}`,
            retryable: false,
          };
        },
      ),
    } as unknown as AiService;
    const worker = new ImageGenerationWorker(
      repository,
      ai,
      {
        statImage: jest.fn().mockResolvedValue(null),
        deleteImage: jest.fn().mockResolvedValue(undefined),
      } as unknown as MinioService,
      {
        refundCreditsOnce: jest.fn().mockResolvedValue(undefined),
      } as unknown as UsersService,
      new ConfigService({
        IMAGE_WORKER_CONCURRENCY: 2,
        IMAGE_QUEUE_POLL_INTERVAL_MS: 60_000,
      }),
    );

    await worker.onApplicationBootstrap();
    await waitUntil(
      () => started.includes('line-a') && started.includes('line-b'),
    );
    releases.get('line-a')?.();
    await waitUntil(
      () =>
        started.includes('retired-line') ||
        started.filter((id) => id === 'line-a').length > 1,
    );

    expect(started).toContain('retired-line');
    const retiredIndex = started.indexOf('retired-line');
    const firstLineAIndex = started.indexOf('line-a');
    const secondLineAIndex = started.indexOf('line-a', firstLineAIndex + 1);
    expect(secondLineAIndex === -1 || retiredIndex < secondLineAIndex).toBe(
      true,
    );
    releases.get('line-b')?.();
    await waitUntil(() => started.filter((id) => id === 'line-a').length > 1);
    releases.get('line-a')?.();
    await waitUntil(() => rows.every((row) => row.status === 'failed'));
    await worker.onApplicationShutdown();
  });

  it('enforces the line limit against active database leases before claiming', async () => {
    const row = pendingImage(50, 'line-a');
    row.inputReferences = [];
    const repository = queueRepository([row]);
    const transactionalRepository = Object.assign(repository, {
      count: jest.fn().mockResolvedValue(3),
    });
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn().mockReturnValue(transactionalRepository),
    };
    const dataSource = {
      options: { type: 'postgres' },
      transaction: jest.fn(
        async (callback: (value: typeof manager) => Promise<unknown>) =>
          callback(manager),
      ),
    } as unknown as DataSource;
    const worker = new ImageGenerationWorker(
      repository,
      {
        getLineMaxConcurrency: jest.fn().mockReturnValue(3),
      } as unknown as AiService,
      {} as MinioService,
      {} as UsersService,
      new ConfigService(),
      dataSource,
    );

    const claimed = await (
      worker as unknown as { claimJob: (id: number) => Promise<Image | null> }
    ).claimJob(row.id);

    expect(claimed).toBeNull();
    expect(manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      ['artgen:image-line:line-a'],
    );
    expect(transactionalRepository.count).toHaveBeenCalled();
    const postgresUpdate = (
      transactionalRepository as unknown as { update: jest.Mock }
    ).update;
    expect(postgresUpdate).toHaveBeenCalledTimes(1);
    const [postgresCriteria, postgresChanges] = (
      postgresUpdate.mock.calls as unknown as Array<
        [Partial<Image>, Partial<Image>]
      >
    )[0];
    expect(postgresCriteria).toMatchObject({ id: row.id, status: 'pending' });
    expect(postgresChanges.availableAt).toBeInstanceOf(Date);
    expect(postgresChanges.availableAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('enforces the line limit with a MySQL named lock across instances', async () => {
    const row = pendingImage(60, 'line-a');
    row.inputReferences = [];
    const repository = queueRepository([row]);
    const transactionalRepository = Object.assign(repository, {
      count: jest.fn().mockResolvedValue(3),
    });
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ acquired: 1 }])
      .mockResolvedValueOnce([{ released: 1 }]);
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query,
      manager: {
        getRepository: jest.fn().mockReturnValue(transactionalRepository),
      },
    };
    const dataSource = {
      options: { type: 'mysql' },
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    } as unknown as DataSource;
    const worker = new ImageGenerationWorker(
      repository,
      {
        getLineMaxConcurrency: jest.fn().mockReturnValue(3),
      } as unknown as AiService,
      {} as MinioService,
      {} as UsersService,
      new ConfigService(),
      dataSource,
    );

    const claimed = await (
      worker as unknown as { claimJob: (id: number) => Promise<Image | null> }
    ).claimJob(row.id);

    expect(claimed).toBeNull();
    expect(query).toHaveBeenNthCalledWith(
      1,
      'SELECT GET_LOCK(?, ?) AS acquired',
      [expect.stringMatching(/^artgen:image-line:[a-f0-9]{40}$/), 5],
    );
    expect(queryRunner.startTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenNthCalledWith(
      2,
      'SELECT RELEASE_LOCK(?) AS released',
      [expect.stringMatching(/^artgen:image-line:[a-f0-9]{40}$/)],
    );
    expect(
      queryRunner.commitTransaction.mock.invocationCallOrder[0],
    ).toBeLessThan(query.mock.invocationCallOrder[1]);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
    const mysqlUpdate = (
      transactionalRepository as unknown as { update: jest.Mock }
    ).update;
    expect(mysqlUpdate).toHaveBeenCalledTimes(1);
    const [mysqlCriteria, mysqlChanges] = (
      mysqlUpdate.mock.calls as unknown as Array<
        [Partial<Image>, Partial<Image>]
      >
    )[0];
    expect(mysqlCriteria).toMatchObject({ id: row.id, status: 'pending' });
    expect(mysqlChanges.availableAt).toBeInstanceOf(Date);
    expect(mysqlChanges.availableAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('claims a pending job from a removed line so it can fail instead of hanging forever', async () => {
    const row = pendingImage(77, 'retired-line');
    const repository = queueRepository([row]);
    const ai = {
      listLines: () => ({
        defaultLineId: 'line-a',
        lines: [{ id: 'line-a', name: '线路 A' }],
      }),
      getLineMaxConcurrency: (lineId: string) => {
        if (lineId === 'line-a') return 3;
        throw new Error(`Unknown AI line: ${lineId}`);
      },
      generateImage: jest.fn().mockResolvedValue({
        success: false,
        error: 'Unknown AI line: retired-line',
        retryable: false,
      }),
    } as unknown as AiService;
    const worker = new ImageGenerationWorker(
      repository,
      ai,
      {
        statImage: jest.fn().mockResolvedValue(null),
        deleteImage: jest.fn().mockResolvedValue(undefined),
      } as unknown as MinioService,
      {
        refundCreditsOnce: jest.fn().mockResolvedValue(undefined),
      } as unknown as UsersService,
      new ConfigService({ IMAGE_QUEUE_POLL_INTERVAL_MS: 60_000 }),
    );

    await worker.onApplicationBootstrap();
    await waitUntil(() => row.status === 'failed');
    await worker.onApplicationShutdown();

    // Jest mock inspection does not invoke the service method.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(ai.generateImage).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      undefined,
      'retired-line',
      expect.any(String),
    );
  });
});
