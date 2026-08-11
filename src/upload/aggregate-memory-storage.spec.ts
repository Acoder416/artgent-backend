import { PayloadTooLargeException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { createAggregateMemoryStorage } from './aggregate-memory-storage';

interface StoredFileInfo {
  buffer: Buffer;
  size: number;
}

function store(
  storage: ReturnType<typeof createAggregateMemoryStorage>,
  request: object,
  chunks: Buffer[],
): Promise<StoredFileInfo> {
  return new Promise((resolve, reject) => {
    storage._handleFile(
      request,
      { stream: Readable.from(chunks) },
      (error, info) => {
        if (error) reject(error);
        else resolve(info!);
      },
    );
  });
}

describe('aggregate upload memory storage', () => {
  it('enforces one byte budget across every file in the same request', async () => {
    const storage = createAggregateMemoryStorage(10);
    const request = {};

    await expect(
      store(storage, request, [Buffer.alloc(3), Buffer.alloc(3)]),
    ).resolves.toMatchObject({ size: 6 });
    await expect(
      store(storage, request, [Buffer.alloc(4)]),
    ).resolves.toMatchObject({ size: 4 });
    await expect(
      store(storage, request, [Buffer.alloc(1)]),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('does not share the aggregate budget between requests', async () => {
    const storage = createAggregateMemoryStorage(5);

    await expect(store(storage, {}, [Buffer.alloc(5)])).resolves.toMatchObject({
      size: 5,
    });
    await expect(store(storage, {}, [Buffer.alloc(5)])).resolves.toMatchObject({
      size: 5,
    });
  });
});
