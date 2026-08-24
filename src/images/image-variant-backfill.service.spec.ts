import { Repository } from 'typeorm';
import { MinioService } from '../upload/minio.service';
import { Image } from './image.entity';
import { ImageVariantBackfillService } from './image-variant-backfill.service';
import { ImageVariantService } from './image-variant.service';

function completedImage(overrides: Partial<Image> = {}): Image {
  return Object.assign(new Image(), {
    id: 17,
    userId: 4,
    status: 'completed',
    imageUrl: 'https://cdn.test/artgen/images/4/17.png',
    imageKey: null,
    mimeType: null,
    imageFormat: null,
    thumbnailUrl: null,
    thumbnailKey: null,
    previewUrl: null,
    previewKey: null,
    ...overrides,
  });
}

function repositoryFor(
  batches: Image[][],
  update = jest.fn().mockResolvedValue({ affected: 1 }),
  findOne = jest.fn().mockResolvedValue(null),
) {
  return {
    find: jest
      .fn()
      .mockImplementation(() => Promise.resolve(batches.shift() ?? [])),
    update,
    findOne,
  } as unknown as Repository<Image>;
}

describe('ImageVariantBackfillService', () => {
  it('is read-only by default and reports eligible rows', async () => {
    const repository = repositoryFor([[completedImage()], []]);
    const minio = { readImageByUrl: jest.fn() } as unknown as MinioService;
    const variants = { generate: jest.fn() } as unknown as ImageVariantService;
    const service = new ImageVariantBackfillService(
      repository,
      minio,
      variants,
    );

    const result = await service.run({ apply: false, batchSize: 10 });

    expect(result).toMatchObject({ scanned: 1, succeeded: 0, failed: 0 });
    expect(minio.readImageByUrl).not.toHaveBeenCalled();
    expect(variants.generate).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('backfills trusted legacy rows with deterministic immutable variants', async () => {
    const image = completedImage();
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    const repository = repositoryFor([[image], []], update);
    const minio = {
      readImageByUrl: jest.fn().mockResolvedValue({
        key: 'images/4/17.png',
        url: image.imageUrl,
        mimeType: 'image/png',
        imageFormat: 'png',
        buffer: Buffer.from('original'),
      }),
      statImage: jest.fn().mockResolvedValue(null),
      storeImage: jest.fn(async (_buffer, _userId, options) => ({
        key: options.key,
        url: `https://cdn.test/artgen/${options.key}`,
        mimeType: 'image/webp',
        imageFormat: 'webp',
      })),
      deleteImage: jest.fn(),
    } as unknown as MinioService;
    const variants = {
      generate: jest.fn().mockResolvedValue({
        thumbnail: Buffer.from('thumbnail'),
        preview: Buffer.from('preview'),
      }),
    } as unknown as ImageVariantService;
    const service = new ImageVariantBackfillService(
      repository,
      minio,
      variants,
    );

    const result = await service.run({ apply: true, batchSize: 10 });

    expect(result).toMatchObject({ scanned: 1, succeeded: 1, failed: 0 });
    expect(minio.storeImage).toHaveBeenNthCalledWith(
      1,
      Buffer.from('thumbnail'),
      4,
      { key: 'images/4/17.thumb.webp' },
    );
    expect(minio.storeImage).toHaveBeenNthCalledWith(
      2,
      Buffer.from('preview'),
      4,
      { key: 'images/4/17.preview.webp' },
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 17, status: 'completed' }),
      expect.objectContaining({
        imageKey: 'images/4/17.png',
        mimeType: 'image/png',
        imageFormat: 'png',
        thumbnailKey: 'images/4/17.thumb.webp',
        previewKey: 'images/4/17.preview.webp',
      }),
    );
  });

  it('cleans newly uploaded variants when the row can no longer be updated', async () => {
    const image = completedImage({ imageKey: 'images/4/17.png' });
    const repository = repositoryFor(
      [[image], []],
      jest.fn().mockResolvedValue({ affected: 0 }),
    );
    const minio = {
      readImage: jest.fn().mockResolvedValue(Buffer.from('original')),
      statImage: jest
        .fn()
        .mockResolvedValueOnce({
          key: image.imageKey,
          url: image.imageUrl,
          mimeType: 'image/png',
          imageFormat: 'png',
          size: 8,
        })
        .mockResolvedValue(null),
      storeImage: jest.fn(async (_buffer, _userId, options) => ({
        key: options.key,
        url: `https://cdn.test/artgen/${options.key}`,
        mimeType: 'image/webp',
        imageFormat: 'webp',
      })),
      deleteImage: jest.fn().mockResolvedValue(undefined),
    } as unknown as MinioService;
    const variants = {
      generate: jest.fn().mockResolvedValue({
        thumbnail: Buffer.from('thumbnail'),
        preview: Buffer.from('preview'),
      }),
    } as unknown as ImageVariantService;
    const service = new ImageVariantBackfillService(
      repository,
      minio,
      variants,
    );

    const result = await service.run({ apply: true, batchSize: 10 });

    expect(result).toMatchObject({ scanned: 1, succeeded: 0, failed: 1 });
    expect(minio.deleteImage).toHaveBeenCalledWith('images/4/17.thumb.webp');
    expect(minio.deleteImage).toHaveBeenCalledWith('images/4/17.preview.webp');
  });

  it('does not delete variants committed by a concurrent backfill', async () => {
    const image = completedImage();
    const keys = {
      thumbnail: 'images/4/17.thumb.webp',
      preview: 'images/4/17.preview.webp',
    };
    const repository = repositoryFor(
      [[image], []],
      jest.fn().mockResolvedValue({ affected: 0 }),
      jest.fn().mockResolvedValue(
        completedImage({
          imageKey: 'images/4/17.png',
          thumbnailKey: keys.thumbnail,
          thumbnailUrl: `https://cdn.test/artgen/${keys.thumbnail}`,
          previewKey: keys.preview,
          previewUrl: `https://cdn.test/artgen/${keys.preview}`,
        }),
      ),
    );
    const minio = {
      readImageByUrl: jest.fn().mockResolvedValue({
        key: 'images/4/17.png',
        url: image.imageUrl,
        mimeType: 'image/png',
        imageFormat: 'png',
        buffer: Buffer.from('original'),
      }),
      statImage: jest.fn().mockResolvedValue(null),
      storeImage: jest.fn(async (_buffer, _userId, options) => ({
        key: options.key,
        url: `https://cdn.test/artgen/${options.key}`,
        mimeType: 'image/webp',
        imageFormat: 'webp',
      })),
      deleteImage: jest.fn().mockResolvedValue(undefined),
    } as unknown as MinioService;
    const variants = {
      generate: jest.fn().mockResolvedValue({
        thumbnail: Buffer.from('thumbnail'),
        preview: Buffer.from('preview'),
      }),
    } as unknown as ImageVariantService;
    const service = new ImageVariantBackfillService(
      repository,
      minio,
      variants,
    );

    const result = await service.run({ apply: true });

    expect(result).toMatchObject({ scanned: 1, succeeded: 1, failed: 0 });
    expect(minio.deleteImage).not.toHaveBeenCalled();
  });

  it('recovers a missing variant key from its trusted URL without regenerating', async () => {
    const image = completedImage({
      imageKey: 'images/4/17.png',
      thumbnailUrl: 'https://cdn.test/artgen/images/4/17.thumb.webp',
      thumbnailKey: null,
      previewUrl: 'https://cdn.test/artgen/images/4/17.preview.webp',
      previewKey: 'images/4/17.preview.webp',
    });
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    const repository = repositoryFor([[image], []], update);
    const minio = {
      statImage: jest.fn(async (key: string) => ({
        key,
        url: `https://cdn.test/artgen/${key}`,
        size: 10,
        mimeType: key.endsWith('.webp') ? 'image/webp' : 'image/png',
        imageFormat: key.endsWith('.webp') ? 'webp' : 'png',
      })),
      readImage: jest.fn().mockResolvedValue(Buffer.from('original')),
      statImageByUrl: jest.fn().mockResolvedValue({
        key: 'images/4/17.thumb.webp',
        url: image.thumbnailUrl,
        size: 10,
        mimeType: 'image/webp',
        imageFormat: 'webp',
      }),
      storeImage: jest.fn(),
      deleteImage: jest.fn(),
    } as unknown as MinioService;
    const variants = { generate: jest.fn() } as unknown as ImageVariantService;
    const service = new ImageVariantBackfillService(
      repository,
      minio,
      variants,
    );

    const result = await service.run({ apply: true });

    expect(result).toMatchObject({ succeeded: 1, failed: 0 });
    expect(variants.generate).not.toHaveBeenCalled();
    expect(minio.storeImage).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        thumbnailKey: 'images/4/17.thumb.webp',
        previewKey: 'images/4/17.preview.webp',
      }),
    );
  });
});
