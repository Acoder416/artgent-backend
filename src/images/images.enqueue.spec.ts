import { DataSource, EntityManager, Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { MinioService } from '../upload/minio.service';
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
            buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
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
        }),
      ],
    });
    expect(rows[0].referenceImageUrls).toEqual([
      expect.stringContaining('/job-inputs/4/'),
    ]);
    expect(wake).toHaveBeenCalledWith(result.images.map((image) => image.id));
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
            buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
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
    expect(wake).toHaveBeenCalledWith([1, 2]);
  });
});
