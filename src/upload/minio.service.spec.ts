import { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import {
  REAL_JPEG_3X2,
  REAL_PNG_3X2,
  REAL_WEBP_3X2,
} from '../test/image-fixtures';
import * as imageFormat from './image-format';
import { MinioService, StoredImageObject } from './minio.service';

const PNG = REAL_PNG_3X2;
const JPEG = REAL_JPEG_3X2;
const WEBP = REAL_WEBP_3X2;

interface FakeMinioClient {
  putObject: jest.Mock;
  statObject: jest.Mock;
  getObject: jest.Mock;
  removeObject: jest.Mock;
}

function createHarness(overrides: Partial<FakeMinioClient> = {}) {
  const client: FakeMinioClient = {
    putObject: jest.fn().mockResolvedValue(undefined),
    statObject: jest.fn(),
    getObject: jest.fn(),
    removeObject: jest.fn(),
    ...overrides,
  };
  const service = new MinioService(
    new ConfigService({
      MINIO_BUCKET: 'artgen-test',
      MINIO_PUBLIC_URL: 'https://cdn.test/artgen',
    }),
  );
  (
    service as unknown as {
      minioClient: FakeMinioClient;
    }
  ).minioClient = client;
  return { client, service };
}

describe('MinioService image storage', () => {
  it('stores an image at a deterministic key with its actual metadata', async () => {
    const { client, service } = createHarness();

    const stored = await service.storeImage(PNG, 7, {
      key: 'images/7/image-42.png',
    });

    expect(stored).toEqual({
      key: 'images/7/image-42.png',
      url: 'https://cdn.test/artgen/images/7/image-42.png',
      mimeType: 'image/png',
      imageFormat: 'png',
    });
    expect(client.putObject).toHaveBeenCalledWith(
      'artgen-test',
      'images/7/image-42.png',
      PNG,
      PNG.length,
      { 'Content-Type': 'image/png' },
    );
  });

  it('creates generated keys under a requested storage folder', async () => {
    const { service } = createHarness();

    const stored = await service.storeImage(WEBP, 7, {
      folder: 'job-inputs',
    });

    expect(stored.key).toMatch(/^job-inputs\/7\/\d+-[a-f0-9]{8}\.webp$/);
    expect(stored.url).toBe(`https://cdn.test/artgen/${stored.key}`);
    expect(stored).toMatchObject({
      mimeType: 'image/webp',
      imageFormat: 'webp',
    });
  });

  it('keeps uploadImage compatible for existing URL callers', async () => {
    const { service } = createHarness();

    const url = await service.uploadImage(JPEG, 7, 'jpg');

    expect(url).toMatch(
      /^https:\/\/cdn\.test\/artgen\/images\/7\/\d+-[a-f0-9]{8}\.jpg$/,
    );
  });

  it('rejects an unsupported binary before uploading it', async () => {
    const { client, service } = createHarness();

    await expect(
      service.storeImage(Buffer.from('not-an-image'), 7),
    ).rejects.toThrow('Unsupported image format');
    expect(client.putObject).not.toHaveBeenCalled();
  });

  it('does not decode pixels twice when the same buffer carries validated metadata', async () => {
    const { service } = createHarness();
    const validatedImage = await imageFormat.inspectDecodedImage(PNG);
    expect(validatedImage).not.toBeNull();
    const inspect = jest.spyOn(imageFormat, 'inspectDecodedImage');

    await service.storeImage(PNG, 7, {
      key: 'images/7/validated.png',
      validatedImage: validatedImage!,
    });

    expect(inspect).not.toHaveBeenCalled();
  });
});

describe('MinioService stored image recovery', () => {
  it('reads an object into a buffer by key', async () => {
    const { service } = createHarness({
      getObject: jest
        .fn()
        .mockResolvedValue(Readable.from([Buffer.from('first-'), 'second'])),
    });

    await expect(
      service.readImage('job-inputs/7/reference.png'),
    ).resolves.toEqual(Buffer.from('first-second'));
  });

  it('rejects an object stream before it exceeds the caller byte budget', async () => {
    const { service } = createHarness({
      getObject: jest
        .fn()
        .mockResolvedValue(Readable.from([Buffer.alloc(4), Buffer.alloc(4)])),
    });

    await expect(
      service.readImage('job-inputs/7/oversized.png', 7),
    ).rejects.toThrow('exceeds the 7-byte limit');
  });

  it('returns stored object metadata by key', async () => {
    const { service } = createHarness({
      statObject: jest.fn().mockResolvedValue({
        size: 123,
        metaData: { 'content-type': 'image/jpeg' },
      }),
    });

    await expect(
      service.statImage('images/7/image-42.jpg'),
    ).resolves.toEqual<StoredImageObject>({
      key: 'images/7/image-42.jpg',
      url: 'https://cdn.test/artgen/images/7/image-42.jpg',
      size: 123,
      mimeType: 'image/jpeg',
      imageFormat: 'jpeg',
    });
  });

  it('returns null when the object does not exist', async () => {
    const { service } = createHarness({
      statObject: jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('missing'), { code: 'NotFound' }),
        ),
    });

    await expect(service.statImage('images/7/missing.png')).resolves.toBeNull();
  });

  it('opens a stored image stream by key', async () => {
    const stream = Readable.from([PNG]);
    const { service } = createHarness({
      statObject: jest.fn().mockResolvedValue({
        size: PNG.length,
        metaData: { 'content-type': 'image/png' },
      }),
      getObject: jest.fn().mockResolvedValue(stream),
    });

    await expect(
      service.openImageByKey('images/7/image-42.png'),
    ).resolves.toMatchObject({
      stream,
      key: 'images/7/image-42.png',
      size: PNG.length,
      contentType: 'image/png',
      imageFormat: 'png',
    });
  });

  it('reads an owned public image URL into a buffer', async () => {
    const { client, service } = createHarness({
      statObject: jest.fn().mockResolvedValue({
        size: PNG.length,
        metaData: { 'content-type': 'image/png' },
      }),
      getObject: jest.fn().mockResolvedValue(Readable.from([PNG])),
    });

    await expect(
      service.readImageByUrl('https://cdn.test/artgen/images/7/image-42.png'),
    ).resolves.toEqual({
      key: 'images/7/image-42.png',
      url: 'https://cdn.test/artgen/images/7/image-42.png',
      size: PNG.length,
      mimeType: 'image/png',
      imageFormat: 'png',
      buffer: PNG,
    });
    expect(client.statObject).toHaveBeenCalledWith(
      'artgen-test',
      'images/7/image-42.png',
    );
  });

  it('rejects an external URL without reading MinIO', async () => {
    const { client, service } = createHarness();

    await expect(
      service.readImageByUrl('https://untrusted.test/reference.png'),
    ).rejects.toThrow('Unsupported image URL');
    expect(client.statObject).not.toHaveBeenCalled();
    expect(client.getObject).not.toHaveBeenCalled();
  });

  it('surfaces strict URL deletion failures so callers can keep their rows', async () => {
    const storageError = new Error('MinIO unavailable');
    const { client, service } = createHarness({
      removeObject: jest.fn().mockRejectedValue(storageError),
    });

    await expect(
      service.deleteImageByUrlStrict(
        'https://cdn.test/artgen/images/7/image-42.png',
      ),
    ).rejects.toThrow(storageError);
    expect(client.removeObject).toHaveBeenCalledWith(
      'artgen-test',
      'images/7/image-42.png',
    );
  });
});
