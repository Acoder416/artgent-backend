import { Repository } from 'typeorm';
import { UsersService } from '../users/users.service';
import { MinioService } from '../upload/minio.service';
import { AiService } from './ai.service';
import { Image } from './image.entity';
import { ImagesService } from './images.service';

describe('ImagesService stored image lifecycle', () => {
  it('removes original and derived objects before deleting the database row', async () => {
    const image = Object.assign(new Image(), {
      id: 20,
      userId: 8,
      imageKey: 'images/8/20.png',
      thumbnailKey: 'images/8/20.thumb.webp',
      previewKey: 'images/8/20.preview.webp',
      status: 'completed',
    });
    const remove = jest.fn().mockResolvedValue(image);
    const repository = {
      findOne: jest.fn().mockResolvedValue(image),
      remove,
    } as unknown as Repository<Image>;
    const deleteImage = jest
      .fn<(key: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const service = new ImagesService(
      repository,
      {} as UsersService,
      {} as AiService,
      { deleteImage } as unknown as MinioService,
    );

    await service.deleteImage(image.id, image.userId);

    expect(deleteImage).toHaveBeenNthCalledWith(1, image.imageKey);
    expect(deleteImage).toHaveBeenNthCalledWith(2, image.thumbnailKey);
    expect(deleteImage).toHaveBeenNthCalledWith(3, image.previewKey);
    expect(deleteImage).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenCalledWith(image);
  });

  it('tries every object but retains the row when a derived deletion fails', async () => {
    const image = Object.assign(new Image(), {
      id: 20,
      userId: 8,
      imageKey: 'images/8/20.png',
      thumbnailKey: 'images/8/20.thumb.webp',
      previewKey: 'images/8/20.preview.webp',
      status: 'completed',
    });
    const remove = jest.fn().mockResolvedValue(image);
    const repository = {
      findOne: jest.fn().mockResolvedValue(image),
      remove,
    } as unknown as Repository<Image>;
    const storageError = new Error('MinIO unavailable');
    const deleteImage = jest.fn((key: string) =>
      key === image.thumbnailKey
        ? Promise.reject(storageError)
        : Promise.resolve(),
    );
    const service = new ImagesService(
      repository,
      {} as UsersService,
      {} as AiService,
      { deleteImage } as unknown as MinioService,
    );

    await expect(service.deleteImage(image.id, image.userId)).rejects.toThrow(
      storageError,
    );
    expect(deleteImage).toHaveBeenNthCalledWith(1, image.imageKey);
    expect(deleteImage).toHaveBeenNthCalledWith(2, image.thumbnailKey);
    expect(deleteImage).toHaveBeenNthCalledWith(3, image.previewKey);
    expect(deleteImage).toHaveBeenCalledTimes(3);
    expect(remove).not.toHaveBeenCalled();
  });

  it('removes legacy stored objects by URL before deleting the database row', async () => {
    const image = Object.assign(new Image(), {
      id: 21,
      userId: 8,
      imageKey: null,
      imageUrl: 'https://static.lzljz.top/artgen/images/8/legacy.png',
      thumbnailKey: null,
      thumbnailUrl:
        'https://static.lzljz.top/artgen/images/8/legacy.thumb.webp',
      previewKey: null,
      previewUrl:
        'https://static.lzljz.top/artgen/images/8/legacy.preview.webp',
      status: 'completed',
    });
    const remove = jest.fn().mockResolvedValue(image);
    const repository = {
      findOne: jest.fn().mockResolvedValue(image),
      remove,
    } as unknown as Repository<Image>;
    const deleteImageByUrlStrict = jest.fn().mockResolvedValue(undefined);
    const service = new ImagesService(
      repository,
      {} as UsersService,
      {} as AiService,
      { deleteImageByUrlStrict } as unknown as MinioService,
    );

    await service.deleteImage(image.id, image.userId);

    expect(deleteImageByUrlStrict).toHaveBeenCalledWith(image.imageUrl);
    expect(deleteImageByUrlStrict).toHaveBeenCalledWith(image.thumbnailUrl);
    expect(deleteImageByUrlStrict).toHaveBeenCalledWith(image.previewUrl);
    expect(deleteImageByUrlStrict).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenCalledWith(image);
  });

  it('keeps the database row when object deletion fails', async () => {
    const image = Object.assign(new Image(), {
      id: 22,
      userId: 8,
      imageKey: 'images/8/22.png',
      imageUrl: 'https://static.lzljz.top/artgen/images/8/22.png',
      status: 'completed',
    });
    const remove = jest.fn().mockResolvedValue(image);
    const repository = {
      findOne: jest.fn().mockResolvedValue(image),
      remove,
    } as unknown as Repository<Image>;
    const storageError = new Error('MinIO unavailable');
    const deleteImage = jest.fn().mockRejectedValue(storageError);
    const service = new ImagesService(
      repository,
      {} as UsersService,
      {} as AiService,
      { deleteImage } as unknown as MinioService,
    );

    await expect(service.deleteImage(image.id, image.userId)).rejects.toThrow(
      storageError,
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it.each(['pending', 'generating'] as const)(
    'does not delete an active %s job',
    async (status) => {
      const image = Object.assign(new Image(), {
        id: 30,
        userId: 8,
        status,
      });
      const remove = jest.fn();
      const repository = {
        findOne: jest.fn().mockResolvedValue(image),
        remove,
      } as unknown as Repository<Image>;
      const minio = {
        deleteImage: jest.fn(),
        deleteImageByUrl: jest.fn(),
      } as unknown as MinioService;
      const service = new ImagesService(
        repository,
        {} as UsersService,
        {} as AiService,
        minio,
      );

      await expect(service.deleteImage(image.id, image.userId)).rejects.toThrow(
        'Image generation is still in progress',
      );
      expect(remove).not.toHaveBeenCalled();
    },
  );

  it('keeps a current queue failure until its refund is committed', async () => {
    const image = Object.assign(new Image(), {
      id: 31,
      userId: 8,
      status: 'failed',
      jobVersion: 1,
      refundedAt: null,
    });
    const remove = jest.fn();
    const repository = {
      findOne: jest.fn().mockResolvedValue(image),
      remove,
    } as unknown as Repository<Image>;
    const service = new ImagesService(
      repository,
      {} as UsersService,
      {} as AiService,
      {
        deleteImage: jest.fn(),
        deleteImageByUrlStrict: jest.fn(),
      } as unknown as MinioService,
    );

    await expect(service.deleteImage(image.id, image.userId)).rejects.toThrow(
      'Image generation refund is still pending',
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it('allows deleting a legacy failure already settled by the old worker', async () => {
    const image = Object.assign(new Image(), {
      id: 32,
      userId: 8,
      status: 'failed',
      jobVersion: 0,
      refundedAt: null,
      imageKey: null,
      imageUrl: null,
    });
    const remove = jest.fn().mockResolvedValue(image);
    const repository = {
      findOne: jest.fn().mockResolvedValue(image),
      remove,
    } as unknown as Repository<Image>;
    const service = new ImagesService(
      repository,
      {} as UsersService,
      {} as AiService,
      {
        deleteImage: jest.fn(),
        deleteImageByUrlStrict: jest.fn(),
      } as unknown as MinioService,
    );

    await service.deleteImage(image.id, image.userId);

    expect(remove).toHaveBeenCalledWith(image);
  });
});
