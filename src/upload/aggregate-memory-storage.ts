import { PayloadTooLargeException } from '@nestjs/common';
import { Readable } from 'node:stream';

export const MAX_IMAGE_UPLOAD_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_UPLOAD_TOTAL_BYTES = 60 * 1024 * 1024;

const aggregateBytes = Symbol('aggregateUploadBytes');

interface UploadRequest {
  [aggregateBytes]?: number;
}

interface IncomingUploadFile {
  stream: Readable;
}

interface StoredUploadFile {
  buffer?: Buffer;
  size?: number;
}

interface StoredFileInfo {
  buffer: Buffer;
  size: number;
}

type StoreCallback = (error: Error | null, info?: StoredFileInfo) => void;

type RemoveCallback = (error: Error | null) => void;

class AggregateMemoryStorage {
  constructor(private readonly maxTotalBytes: number) {}

  _handleFile(
    request: UploadRequest,
    file: IncomingUploadFile,
    callback: StoreCallback,
  ): void {
    const chunks: Buffer[] = [];
    let fileBytes = 0;
    let finished = false;

    file.stream.on('data', (value: unknown) => {
      if (finished) return;
      const chunk = Buffer.isBuffer(value)
        ? value
        : Buffer.from(value as Uint8Array);
      const nextTotal = (request[aggregateBytes] || 0) + chunk.length;
      if (nextTotal > this.maxTotalBytes) {
        finished = true;
        chunks.length = 0;
        callback(
          new PayloadTooLargeException(
            `Uploaded images exceed the ${this.maxTotalBytes}-byte request limit`,
          ),
        );
        return;
      }
      request[aggregateBytes] = nextTotal;
      fileBytes += chunk.length;
      chunks.push(chunk);
    });
    file.stream.once('error', (error: Error) => {
      if (finished) return;
      finished = true;
      chunks.length = 0;
      callback(error);
    });
    file.stream.once('end', () => {
      if (finished) return;
      finished = true;
      callback(null, {
        buffer: Buffer.concat(chunks, fileBytes),
        size: fileBytes,
      });
    });
  }

  _removeFile(
    _request: UploadRequest,
    file: StoredUploadFile,
    callback: RemoveCallback,
  ): void {
    delete file.buffer;
    delete file.size;
    callback(null);
  }
}

export function createAggregateMemoryStorage(
  maxTotalBytes = MAX_IMAGE_UPLOAD_TOTAL_BYTES,
): AggregateMemoryStorage {
  return new AggregateMemoryStorage(maxTotalBytes);
}
