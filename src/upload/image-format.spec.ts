import {
  REAL_JPEG_3X2,
  REAL_PNG_3X2,
  REAL_WEBP_3X2,
} from '../test/image-fixtures';
import { crc32 as zlibCrc32 } from 'node:zlib';
import {
  detectImageDimensions,
  detectImageMetadata,
  inspectDecodedImage,
  MAX_PNG_ANCILLARY_BYTES,
} from './image-format';

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    zlibCrc32(Buffer.concat([typeBuffer, data])),
    8 + data.length,
  );
  return chunk;
}

function expectInvalidImage(image: Buffer): void {
  expect(detectImageMetadata(image)).toBeNull();
  expect(detectImageDimensions(image)).toBeNull();
}

describe('detectImageMetadata', () => {
  it.each([
    ['PNG', REAL_PNG_3X2, { mimeType: 'image/png', imageFormat: 'png' }],
    ['JPEG', REAL_JPEG_3X2, { mimeType: 'image/jpeg', imageFormat: 'jpeg' }],
    ['WebP', REAL_WEBP_3X2, { mimeType: 'image/webp', imageFormat: 'webp' }],
  ])('recognizes a structurally valid %s image', (_label, image, expected) => {
    expect(detectImageMetadata(image)).toEqual(expected);
  });

  it.each([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0xff, 0xd8, 0xff, 0xdb]),
    Buffer.from('524946460000000057454250', 'hex'),
  ])('does not label a signature-only payload as an image', (image) => {
    expect(detectImageMetadata(image)).toBeNull();
  });

  it('does not label an unknown binary payload as an image', () => {
    expect(detectImageMetadata(Buffer.from('not-an-image'))).toBeNull();
  });
});

describe('detectImageDimensions', () => {
  it.each([
    ['PNG', REAL_PNG_3X2],
    ['JPEG', REAL_JPEG_3X2],
    ['WebP', REAL_WEBP_3X2],
  ])(
    'reads the real dimensions from a structurally valid %s',
    (_label, image) => {
      expect(detectImageDimensions(image)).toEqual({ width: 3, height: 2 });
    },
  );

  it.each([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0xff, 0xd8, 0xff, 0xdb]),
    Buffer.from('524946460000000057454250', 'hex'),
  ])('does not invent dimensions for a signature-only payload', (image) => {
    expect(detectImageDimensions(image)).toBeNull();
  });

  it.each([
    ['PNG without IDAT/IEND', REAL_PNG_3X2.subarray(0, 33)],
    ['JPEG without EOI', REAL_JPEG_3X2.subarray(0, -2)],
    ['truncated WebP RIFF', REAL_WEBP_3X2.subarray(0, -1)],
  ])('rejects a structurally incomplete %s payload', (_label, image) => {
    expect(detectImageMetadata(image)).toBeNull();
    expect(detectImageDimensions(image)).toBeNull();
  });

  it('rejects PNG dimensions outside the signed 31-bit format range', () => {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452ffffffff00000001080000000025374916',
      'hex',
    );

    expect(detectImageDimensions(png)).toBeNull();
  });
});

describe('complete image structure validation', () => {
  it.each([
    ['a PNG without IEND', REAL_PNG_3X2.subarray(0, -12)],
    [
      'a PNG with bytes after IEND',
      Buffer.concat([REAL_PNG_3X2, Buffer.from([0])]),
    ],
  ])('rejects %s', (_label, image) => {
    expectInvalidImage(image);
  });

  it('rejects a PNG whose image-data CRC is corrupt', () => {
    const image = Buffer.from(REAL_PNG_3X2);
    const idatTypeOffset = image.indexOf(Buffer.from('IDAT'));
    expect(idatTypeOffset).toBeGreaterThan(0);
    image[idatTypeOffset + 4] ^= 0xff;

    expectInvalidImage(image);
  });

  it('rejects a PNG with an oversized ancillary metadata budget', () => {
    const oversizedText = pngChunk(
      'iTXt',
      Buffer.alloc(MAX_PNG_ANCILLARY_BYTES + 1),
    );
    const image = Buffer.concat([
      REAL_PNG_3X2.subarray(0, 33),
      oversizedText,
      REAL_PNG_3X2.subarray(33),
    ]);

    expectInvalidImage(image);
  });

  it.each([
    [
      'a JPEG without an SOS scan',
      Buffer.concat([
        REAL_JPEG_3X2.subarray(
          0,
          REAL_JPEG_3X2.indexOf(Buffer.from([0xff, 0xda])),
        ),
        Buffer.from([0xff, 0xd9]),
      ]),
    ],
    [
      'a JPEG with bytes after EOI',
      Buffer.concat([REAL_JPEG_3X2, Buffer.from([0])]),
    ],
  ])('rejects %s', (_label, image) => {
    expectInvalidImage(image);
  });

  it('rejects WebP when the RIFF size does not consume the whole payload', () => {
    const image = Buffer.concat([REAL_WEBP_3X2, Buffer.from([0, 0])]);

    expectInvalidImage(image);
  });

  it('rejects an extended WebP header without image data', () => {
    const image = Buffer.alloc(30);
    image.write('RIFF', 0, 'ascii');
    image.writeUInt32LE(image.length - 8, 4);
    image.write('WEBP', 8, 'ascii');
    image.write('VP8X', 12, 'ascii');
    image.writeUInt32LE(10, 16);
    image.writeUIntLE(2, 24, 3);
    image.writeUIntLE(1, 27, 3);

    expectInvalidImage(image);
  });

  it('rejects a truncated VP8 main chunk even when its dimensions fit', () => {
    const image = Buffer.alloc(30);
    image.write('RIFF', 0, 'ascii');
    image.writeUInt32LE(image.length - 8, 4);
    image.write('WEBP', 8, 'ascii');
    image.write('VP8 ', 12, 'ascii');
    image.writeUInt32LE(10, 16);
    REAL_WEBP_3X2.copy(image, 20, 20, 30);

    expectInvalidImage(image);
  });
});

describe('decoded image validation', () => {
  const fakePng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAUlEQVQAKDh96AAAAABJRU5ErkJggg==',
    'base64',
  );
  const fakeJpeg = Buffer.from('ffd8ffc000070800010001ffda0002ffd9', 'hex');
  const fakeWebp = (() => {
    const image = Buffer.alloc(38);
    image.write('RIFF', 0, 'ascii');
    image.writeUInt32LE(image.length - 8, 4);
    image.write('WEBP', 8, 'ascii');
    image.write('VP8 ', 12, 'ascii');
    image.writeUInt32LE(17, 16);
    image.writeUIntLE((14 << 5) | 0x10, 20, 3);
    Buffer.from([0x9d, 0x01, 0x2a]).copy(image, 23);
    image.writeUInt16LE(1, 26);
    image.writeUInt16LE(1, 28);
    return image;
  })();

  it.each([
    ['PNG', fakePng],
    ['JPEG', fakeJpeg],
    ['WebP', fakeWebp],
  ])(
    'rejects a structurally plausible but undecodable %s',
    async (_label, image) => {
      expect(detectImageMetadata(image)).not.toBeNull();
      await expect(inspectDecodedImage(image)).resolves.toBeNull();
    },
  );

  it.each([
    ['PNG', REAL_PNG_3X2, 'png'],
    ['JPEG', REAL_JPEG_3X2, 'jpeg'],
    ['WebP', REAL_WEBP_3X2, 'webp'],
  ])('fully decodes a real %s fixture', async (_label, image, imageFormat) => {
    await expect(inspectDecodedImage(image)).resolves.toMatchObject({
      imageFormat,
      width: 3,
      height: 2,
    });
  });
});
