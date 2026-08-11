import { createHash } from 'node:crypto';
import { crc32 as zlibCrc32 } from 'node:zlib';
import sharp from 'sharp';

export type ImageFormat = 'png' | 'jpeg' | 'webp';

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ImageMetadata {
  mimeType: ImageMimeType;
  imageFormat: ImageFormat;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface DecodedImage extends ImageMetadata, ImageDimensions {
  sha256: string;
}

type StructuredImage = ImageMetadata & ImageDimensions;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
export const MAX_PNG_ANCILLARY_BYTES = 4 * 1024 * 1024;
const MAX_PNG_TOTAL_ANCILLARY_BYTES = 8 * 1024 * 1024;

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function validDimensions(
  width: number,
  height: number,
): ImageDimensions | null {
  return width > 0 &&
    height > 0 &&
    width <= 0x7fffffff &&
    height <= 0x7fffffff &&
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height)
    ? { width, height }
    : null;
}

function crc32(buffer: Buffer, start: number, end: number): number {
  return zlibCrc32(buffer.subarray(start, end));
}

function parsePngDimensions(buffer: Buffer): ImageDimensions | null {
  if (
    buffer.length < PNG_SIGNATURE.length ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return null;
  }

  let offset = PNG_SIGNATURE.length;
  let dimensions: ImageDimensions | null = null;
  let sawIdat = false;
  let ancillaryBytes = 0;

  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) return null;
    const chunkLength = buffer.readUInt32BE(offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const dataEnd = dataOffset + chunkLength;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataOffset || chunkEnd > buffer.length) return null;

    const chunkType = buffer.toString('ascii', typeOffset, dataOffset);
    const isAncillary = (buffer[typeOffset] & 0x20) !== 0;
    if (isAncillary) {
      ancillaryBytes += chunkLength;
      if (
        chunkLength > MAX_PNG_ANCILLARY_BYTES ||
        ancillaryBytes > MAX_PNG_TOTAL_ANCILLARY_BYTES
      ) {
        return null;
      }
    }
    const storedCrc = buffer.readUInt32BE(dataEnd);
    if (crc32(buffer, typeOffset, dataEnd) !== storedCrc) return null;

    if (offset === PNG_SIGNATURE.length) {
      if (chunkType !== 'IHDR' || chunkLength !== 13) return null;
      dimensions = validDimensions(
        buffer.readUInt32BE(dataOffset),
        buffer.readUInt32BE(dataOffset + 4),
      );
      if (!dimensions) return null;
    } else if (chunkType === 'IHDR') {
      return null;
    }

    if (chunkType === 'IDAT') {
      if (!dimensions || chunkLength === 0) return null;
      sawIdat = true;
    }
    if (chunkType === 'IEND') {
      return chunkLength === 0 && sawIdat && chunkEnd === buffer.length
        ? dimensions
        : null;
    }
    offset = chunkEnd;
  }

  return null;
}

function parseJpegDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  let dimensions: ImageDimensions | null = null;
  let sawScan = false;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return null;

    const marker = buffer[offset];
    offset += 1;
    if (marker === 0x00) return null;
    if (marker === 0xd9) {
      return sawScan && offset === buffer.length ? dimensions : null;
    }

    // TEM, restart, and repeated SOI markers do not carry a length field.
    if (
      marker === 0x01 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }

    if (offset + 2 > buffer.length) return null;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      return null;
    }

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) return null;
      const dataOffset = offset + 2;
      dimensions = validDimensions(
        buffer.readUInt16BE(dataOffset + 3),
        buffer.readUInt16BE(dataOffset + 1),
      );
      if (!dimensions) return null;
    }

    if (marker !== 0xda) {
      offset += segmentLength;
      continue;
    }

    sawScan = true;
    offset += segmentLength;
    // Entropy-coded scan data uses FF 00 byte stuffing and may contain restart
    // markers. Stop only at a real marker so the outer loop can validate EOI.
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const markerOffset = offset;
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      if (offset >= buffer.length) return null;
      const scanMarker = buffer[offset];
      if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
        offset += 1;
        continue;
      }
      offset = markerOffset;
      break;
    }
  }

  return null;
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return (
    buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
  );
}

function parseWebpDimensions(buffer: Buffer): ImageDimensions | null {
  if (
    buffer.length < 20 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return null;
  }

  const riffEnd = 8 + buffer.readUInt32LE(4);
  if (riffEnd !== buffer.length) return null;

  let offset = 12;
  let dimensions: ImageDimensions | null = null;
  let hasImagePayload = false;
  while (offset < riffEnd) {
    if (offset + 8 > riffEnd) return null;
    const chunkType = buffer.toString('ascii', offset, offset + 4);
    const chunkLength = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkLength;
    const nextOffset = dataEnd + (chunkLength & 1);
    if (dataEnd < dataOffset || dataEnd > riffEnd || nextOffset > riffEnd) {
      return null;
    }

    if (chunkType === 'VP8X') {
      if (chunkLength < 10 || dimensions) return null;
      dimensions = validDimensions(
        readUInt24LE(buffer, dataOffset + 4) + 1,
        readUInt24LE(buffer, dataOffset + 7) + 1,
      );
      if (!dimensions) return null;
    } else if (chunkType === 'VP8 ') {
      if (
        chunkLength < 10 ||
        buffer[dataOffset + 3] !== 0x9d ||
        buffer[dataOffset + 4] !== 0x01 ||
        buffer[dataOffset + 5] !== 0x2a
      ) {
        return null;
      }
      const frameTag = readUInt24LE(buffer, dataOffset);
      const firstPartitionLength = frameTag >>> 5;
      if (
        (frameTag & 1) !== 0 ||
        (frameTag & 0x10) === 0 ||
        firstPartitionLength < 7 ||
        chunkLength < 3 + firstPartitionLength
      ) {
        return null;
      }
      const payloadDimensions = validDimensions(
        buffer.readUInt16LE(dataOffset + 6) & 0x3fff,
        buffer.readUInt16LE(dataOffset + 8) & 0x3fff,
      );
      if (!payloadDimensions) return null;
      dimensions ??= payloadDimensions;
      hasImagePayload = true;
    } else if (chunkType === 'VP8L') {
      if (chunkLength < 5 || buffer[dataOffset] !== 0x2f) return null;
      const packedDimensions = buffer.readUInt32LE(dataOffset + 1);
      const payloadDimensions = validDimensions(
        (packedDimensions & 0x3fff) + 1,
        ((packedDimensions >>> 14) & 0x3fff) + 1,
      );
      if (!payloadDimensions) return null;
      dimensions ??= payloadDimensions;
      hasImagePayload = true;
    }

    offset = nextOffset;
  }

  return offset === riffEnd && hasImagePayload ? dimensions : null;
}

function inspectImageStructure(buffer: Buffer): StructuredImage | null {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const png = parsePngDimensions(buffer);
  if (png) {
    return { mimeType: 'image/png', imageFormat: 'png', ...png };
  }
  const jpeg = parseJpegDimensions(buffer);
  if (jpeg) {
    return { mimeType: 'image/jpeg', imageFormat: 'jpeg', ...jpeg };
  }
  const webp = parseWebpDimensions(buffer);
  if (webp) {
    return { mimeType: 'image/webp', imageFormat: 'webp', ...webp };
  }
  return null;
}

export function detectImageMetadata(buffer: Buffer): ImageMetadata | null {
  const image = inspectImageStructure(buffer);
  return image
    ? { mimeType: image.mimeType, imageFormat: image.imageFormat }
    : null;
}

export function detectImageDimensions(buffer: Buffer): ImageDimensions | null {
  const image = inspectImageStructure(buffer);
  return image ? { width: image.width, height: image.height } : null;
}

export async function inspectDecodedImage(
  buffer: Buffer,
): Promise<DecodedImage | null> {
  const image = inspectImageStructure(buffer);
  if (!image) return null;

  try {
    const options = {
      failOn: 'error' as const,
      limitInputPixels: 40_000_000,
      sequentialRead: true,
    };
    const decodedMetadata = await sharp(buffer, options).metadata();
    if (
      decodedMetadata.format !== image.imageFormat ||
      decodedMetadata.width !== image.width ||
      decodedMetadata.height !== image.height
    ) {
      return null;
    }
    // Force libvips to decode image pixels while keeping output memory bounded.
    await sharp(buffer, options).resize(1, 1, { fit: 'fill' }).raw().toBuffer();
    return {
      ...image,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    };
  } catch {
    return null;
  }
}
