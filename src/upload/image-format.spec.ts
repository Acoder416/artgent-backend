import { detectImageMetadata } from './image-format';

describe('detectImageMetadata', () => {
  it.each([
    [
      'PNG',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      { mimeType: 'image/png', imageFormat: 'png' },
    ],
    [
      'JPEG',
      Buffer.from([0xff, 0xd8, 0xff, 0xdb]),
      { mimeType: 'image/jpeg', imageFormat: 'jpeg' },
    ],
    [
      'WebP',
      Buffer.from('524946460000000057454250', 'hex'),
      { mimeType: 'image/webp', imageFormat: 'webp' },
    ],
  ])('recognizes a %s image from its bytes', (_label, image, expected) => {
    expect(detectImageMetadata(image)).toEqual(expected);
  });

  it('does not label an unknown binary payload as an image', () => {
    expect(detectImageMetadata(Buffer.from('not-an-image'))).toBeNull();
  });
});
