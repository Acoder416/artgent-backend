import { DataSource, EntityManager, Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { MinioService } from '../upload/minio.service';
import { REAL_PNG_3X2 } from '../test/image-fixtures';
import { AiService } from './ai.service';
import { ImageGenerationWorker } from './image-generation.worker';
import { Image } from './image.entity';
import { ImagesService } from './images.service';

describe('ImagesService durable enqueue', () => {
  it('stages uploaded references before persisting pending jobs', async () => {
    const user = Object.assign(new User(), {
      id: 4,
      credits: 5,
      totalCreditsSpent: 0,
      role: 'user',
    });
    const userRepository = {
      findOne: jest.fn().mockResolvedValue(user),
      save: jest.fn((candidate: User) => Promise.resolve(candidate)),
    } as unknown as Repository<User>;
    const rows: Image[] = [];
    const imageRepository = {
      create: (input: Partial<Image>) => Object.assign(new Image(), input),
      save: jest.fn((images: Image[]) => {
        for (const image of images) {
          image.id = rows.length + 1;
          rows.push(image);
        }
        return Promise.resolve(images);
      }),
    } as unknown as Repository<Image>;
    const ai = {
      resolveLineId: () => 'line-a',
    } as unknown as AiService;
    const storeImage = jest.fn(
      (_buffer: Buffer, _userId: number, options: { key: string }) =>
        Promise.resolve({
          key: options.key,
          url: `https://static.lzljz.top/artgen/${options.key}`,
          imageFormat: 'png',
          mimeType: 'image/png',
        }),
    );
    const minio = { storeImage } as unknown as MinioService;
    const wake = jest.fn();
    const service = new ImagesService(
      imageRepository,
      new UsersService(userRepository),
      ai,
      minio,
      { wake } as unknown as ImageGenerationWorker,
    );

    const result = await service.generateBatch(
      user.id,
      {
        prompt: 'Keep the product and replace the background',
        quantity: 2,
      },
      {
        files: [
          {
            buffer: REAL_PNG_3X2,
            mimetype: 'image/png',
            originalname: 'product.png',
          },
        ],
      },
    );

    expect(storeImage).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      status: 'pending',
      jobVersion: 1,
      attemptCount: 0,
      inputReferences: [
        expect.objectContaining({
          kind: 'object',
          mimeType: 'image/png',
          originalName: 'product.png',
          size: REAL_PNG_3X2.length,
        }),
      ],
    });
    expect(rows[0].referenceImageUrls).toEqual([
      expect.stringContaining('/job-inputs/4/'),
    ]);
    expect(wake).toHaveBeenCalledWith(
      result.images.map((image) => image.id),
      'line-a',
    );
  });

  it('stages an uploaded mask without exposing it as a reference image URL', async () => {
    const user = Object.assign(new User(), {
      id: 14,
      credits: 5,
      totalCreditsSpent: 0,
      role: 'user',
    });
    const rows: Image[] = [];
    const imageRepository = {
      create: (input: Partial<Image>) => Object.assign(new Image(), input),
      save: jest.fn((images: Image[]) => {
        images.forEach((image, index) => {
          image.id = index + 1;
          rows.push(image);
        });
        return Promise.resolve(images);
      }),
    } as unknown as Repository<Image>;
    const storeImage = jest.fn(
      (_buffer: Buffer, _userId: number, options: { key: string }) =>
        Promise.resolve({
          key: options.key,
          url: `https://static.lzljz.top/artgen/${options.key}`,
          imageFormat: 'png' as const,
          mimeType: 'image/png' as const,
        }),
    );
    const service = new ImagesService(
      imageRepository,
      {
        findById: jest.fn().mockResolvedValue(user),
        deductCredits: jest.fn().mockResolvedValue(user),
      } as unknown as UsersService,
      { resolveLineId: () => 'line-a' } as unknown as AiService,
      { storeImage } as unknown as MinioService,
    );
    const reference = {
      buffer: REAL_PNG_3X2,
      mimetype: 'image/png',
      originalname: 'reference.png',
    };
    const mask = {
      buffer: REAL_PNG_3X2,
      mimetype: 'image/png',
      originalname: 'mask.png',
    };

    await service.generateBatch(
      user.id,
      { prompt: 'Replace only the masked area' },
      { file: reference, mask },
    );

    expect(storeImage).toHaveBeenCalledTimes(2);
    expect(rows[0].inputReferences).toEqual([
      expect.objectContaining({ role: 'image', originalName: 'reference.png' }),
      expect.objectContaining({ role: 'mask', originalName: 'mask.png' }),
    ]);
    expect(rows[0].referenceImageUrls).toHaveLength(1);
    expect(rows[0].referenceImageUrls?.[0]).toContain('/job-inputs/14/');
  });

  it('copies an owned MinIO URL into durable job input storage', async () => {
    const png = REAL_PNG_3X2;
    const sourceUrl = 'https://static.lzljz.top/artgen/images/4/existing.png';
    const user = Object.assign(new User(), {
      id: 4,
      credits: 5,
      totalCreditsSpent: 0,
      role: 'user',
    });
    const rows: Image[] = [];
    const imageRepository = {
      create: (input: Partial<Image>) => Object.assign(new Image(), input),
      save: jest.fn((images: Image[]) => {
        images.forEach((image, index) => {
          image.id = index + 1;
          rows.push(image);
        });
        return Promise.resolve(images);
      }),
    } as unknown as Repository<Image>;
    const usersService = {
      findById: jest.fn().mockResolvedValue(user),
      deductCredits: jest.fn().mockResolvedValue(user),
      refundCreditsOnce: jest.fn(),
    } as unknown as UsersService;
    const readImageByUrl = jest.fn().mockResolvedValue({
      key: 'images/4/existing.png',
      url: sourceUrl,
      size: png.length,
      mimeType: 'image/png',
      imageFormat: 'png',
      buffer: png,
    });
    const storeImage = jest.fn(
      (_buffer: Buffer, _userId: number, options: { key: string }) =>
        Promise.resolve({
          key: options.key,
          url: `https://static.lzljz.top/artgen/${options.key}`,
          imageFormat: 'png',
          mimeType: 'image/png',
        }),
    );
    const wake = jest.fn();
    const service = new ImagesService(
      imageRepository,
      usersService,
      { resolveLineId: () => 'line-a' } as unknown as AiService,
      { readImageByUrl, storeImage } as unknown as MinioService,
      { wake } as unknown as ImageGenerationWorker,
    );

    await service.generateBatch(user.id, {
      prompt: 'Keep the subject and replace the background',
      referenceImageUrls: [sourceUrl],
    });

    expect(readImageByUrl).toHaveBeenCalledWith(sourceUrl, 20 * 1024 * 1024);
    expect(storeImage).toHaveBeenCalledTimes(1);
    const [stagedBuffer, stagedUserId, stagedOptions] =
      storeImage.mock.calls[0];
    expect(stagedBuffer).toBe(png);
    expect(stagedUserId).toBe(user.id);
    expect(stagedOptions.key).toMatch(
      /^job-inputs\/4\/[a-f0-9-]+\/1-[a-f0-9]{8}\.png$/,
    );
    expect(rows[0].inputReferences).toEqual([
      expect.objectContaining({
        kind: 'object',
        mimeType: 'image/png',
        originalName: 'existing.png',
      }),
    ]);
    expect(rows[0].inputReferences).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'url' })]),
    );
  });

  it('rejects external reference URLs before charging or saving a job', async () => {
    const save = jest.fn();
    const deductCredits = jest.fn();
    const readImageByUrl = jest
      .fn()
      .mockRejectedValue(new Error('Unsupported image URL'));
    const service = new ImagesService(
      {
        create: (input: Partial<Image>) => Object.assign(new Image(), input),
        save,
      } as unknown as Repository<Image>,
      {
        findById: jest.fn().mockResolvedValue({
          id: 5,
          role: 'user',
          credits: 5,
        }),
        deductCredits,
      } as unknown as UsersService,
      { resolveLineId: () => 'line-a' } as unknown as AiService,
      { readImageByUrl, storeImage: jest.fn() } as unknown as MinioService,
    );

    await expect(
      service.generateBatch(5, {
        prompt: 'Use an external reference',
        referenceImageUrls: ['https://untrusted.test/reference.png'],
      }),
    ).rejects.toThrow('Reference image URL must point to an ArtGen image');

    expect(save).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('limits uploaded files and URL references to five images in total', async () => {
    const png = REAL_PNG_3X2;
    const storeImage = jest.fn();
    const readImageByUrl = jest.fn();
    const service = new ImagesService(
      {} as Repository<Image>,
      {
        findById: jest.fn().mockResolvedValue({
          id: 6,
          role: 'user',
          credits: 10,
        }),
      } as unknown as UsersService,
      { resolveLineId: () => 'line-a' } as unknown as AiService,
      { readImageByUrl, storeImage } as unknown as MinioService,
    );

    await expect(
      service.generateBatch(
        6,
        {
          prompt: 'Too many references',
          referenceImageUrls: [
            'https://static.test/artgen/images/6/first.png',
            'https://static.test/artgen/images/6/second.png',
          ],
        },
        {
          files: Array.from({ length: 4 }, (_, index) => ({
            buffer: png,
            mimetype: 'image/png',
            originalname: `upload-${index + 1}.png`,
          })),
        },
      ),
    ).rejects.toThrow('A maximum of 5 reference images is allowed');

    expect(readImageByUrl).not.toHaveBeenCalled();
    expect(storeImage).not.toHaveBeenCalled();
  });

  it('refunds credits and removes staged inputs when persisting the batch fails', async () => {
    const user = Object.assign(new User(), {
      id: 8,
      credits: 5,
      totalCreditsSpent: 0,
      role: 'user',
    });
    const imageRepository = {
      create: (input: Partial<Image>) => Object.assign(new Image(), input),
      save: jest.fn().mockRejectedValue(new Error('database unavailable')),
    } as unknown as Repository<Image>;
    const deductCredits = jest.fn().mockResolvedValue(user);
    const refundCreditsOnce = jest.fn().mockResolvedValue(user);
    const usersService = {
      findById: jest.fn().mockResolvedValue(user),
      deductCredits,
      refundCreditsOnce,
    } as unknown as UsersService;
    const ai = {
      resolveLineId: () => 'line-a',
    } as unknown as AiService;
    const stagedKey = 'job-inputs/8/request/reference.png';
    const deleteImage = jest
      .fn()
      .mockRejectedValue(new Error('cleanup failed'));
    const minio = {
      storeImage: jest.fn().mockResolvedValue({
        key: stagedKey,
        url: `https://static.example.com/artgen/${stagedKey}`,
        imageFormat: 'png',
        mimeType: 'image/png',
      }),
      deleteImage,
    } as unknown as MinioService;
    const wake = jest.fn();
    const service = new ImagesService(
      imageRepository,
      usersService,
      ai,
      minio,
      { wake } as unknown as ImageGenerationWorker,
    );

    await expect(
      service.generateBatch(
        user.id,
        { prompt: 'A product photo', quantity: 2 },
        {
          file: {
            buffer: REAL_PNG_3X2,
            mimetype: 'image/png',
            originalname: 'reference.png',
          },
        },
      ),
    ).rejects.toThrow('database unavailable');

    expect(refundCreditsOnce).toHaveBeenCalledWith(
      user.id,
      2,
      expect.stringMatching(/^enqueue:/),
      'Image generation enqueue failed: refund 2 credits',
    );
    expect(deleteImage).toHaveBeenCalledWith(stagedKey);
    expect(wake).not.toHaveBeenCalled();
  });

  it('charges credits and saves the whole batch in one database transaction', async () => {
    const user = Object.assign(new User(), {
      id: 12,
      credits: 5,
      totalCreditsSpent: 0,
      role: 'user',
    });
    const imageRepository = {
      create: (input: Partial<Image>) => Object.assign(new Image(), input),
    } as unknown as Repository<Image>;
    const deductCreditsInTransaction = jest.fn().mockResolvedValue(user);
    const deductCredits = jest.fn();
    const usersService = {
      findById: jest.fn().mockResolvedValue(user),
      deductCreditsInTransaction,
      deductCredits,
      refundCreditsOnce: jest.fn(),
    } as unknown as UsersService;
    const save = jest.fn((_entity: typeof Image, images: Image[]) => {
      images.forEach((image, index) => {
        image.id = index + 1;
      });
      return Promise.resolve(images);
    });
    const manager = {
      save,
    } as unknown as EntityManager;
    const dataSource = {
      transaction: <T>(
        operation: (transactionManager: EntityManager) => Promise<T>,
      ) => operation(manager),
    } as unknown as DataSource;
    const wake = jest.fn();
    const service = new ImagesService(
      imageRepository,
      usersService,
      { resolveLineId: () => 'line-a' } as unknown as AiService,
      {} as MinioService,
      { wake } as unknown as ImageGenerationWorker,
      dataSource,
    );

    const result = await service.generateBatch(user.id, {
      prompt: 'A durable batch',
      quantity: 2,
    });

    expect(deductCreditsInTransaction).toHaveBeenCalledWith(
      manager,
      user.id,
      2,
      '生成 2 张图片',
      result.requestId,
    );
    expect(save).toHaveBeenCalledWith(Image, expect.any(Array));
    expect(deductCredits).not.toHaveBeenCalled();
    expect(wake).toHaveBeenCalledWith([1, 2], 'line-a');
  });
});
