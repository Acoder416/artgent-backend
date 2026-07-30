export type ImageFormat = 'png' | 'jpeg' | 'webp';

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ImageMetadata {
  mimeType: ImageMimeType;
  imageFormat: ImageFormat;
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export function detectImageMetadata(buffer: Buffer): ImageMetadata | null {
  if (
    buffer.length >= PNG_SIGNATURE.length &&
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return { mimeType: 'image/png', imageFormat: 'png' };
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { mimeType: 'image/jpeg', imageFormat: 'jpeg' };
  }

  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { mimeType: 'image/webp', imageFormat: 'webp' };
  }

  return null;
}
