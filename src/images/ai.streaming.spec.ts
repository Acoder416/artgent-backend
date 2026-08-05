import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { Readable } from 'node:stream';
import { AiService } from './ai.service';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function createService(overrides: Record<string, unknown> = {}) {
  return new AiService(
    new ConfigService({
      AI_LINE_A_BASE_URL: 'https://gateway.test',
      AI_LINE_A_API_KEY: 'test-key',
      AI_LINE_B_BASE_URL: 'https://gateway.test',
      AI_LINE_B_API_KEY: 'test-key',
      ...overrides,
    }),
  );
}

function streamingAxiosFailure(status: number, message: string) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: {
      status,
      data: Readable.from([
        JSON.stringify({
          error: { message },
        }),
      ]),
      headers: { 'content-type': 'application/json' },
    },
  });
}

describe('AiService image streaming responses', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the completed generation image from a chunked SSE stream', async () => {
    const base64 = PNG.toString('base64');
    const body = [
      ': keepalive\r\n\r\n',
      'data: {"type":"image_generation.partial_image","b64_json":"bm90LWFuLWltYWdl","partial_image_index":0}\r\n\r\n',
      `data: {"type":"image_generation.completed","b64_json":"${base64}"}\r\n\r\n`,
    ].join('');
    const splitAt = body.indexOf('completed') + 5;
    const chunks = [
      body.slice(0, 17),
      body.slice(17, splitAt),
      body.slice(splitAt),
    ];

    jest.spyOn(axios, 'post').mockResolvedValue({
      data: Readable.from(chunks.map((chunk) => Buffer.from(chunk))),
      headers: { 'content-type': 'text/event-stream' },
    });

    const result = await createService().generateImage('A product photograph');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.imageBuffer).toEqual(PNG);
      expect(result.imageFormat).toBe('png');
    }
  });

  it('falls back to a normal JSON response when the provider ignores streaming', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: Readable.from([
        JSON.stringify({
          data: [{ b64_json: PNG.toString('base64') }],
        }),
      ]),
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

    const result = await createService().generateImage('A product photograph');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.imageBuffer).toEqual(PNG);
      expect(result.imageFormat).toBe('png');
    }
  });

  it('marks a stream without a completed event as retryable', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: Readable.from([
        'data: {"type":"image_generation.partial_image"}\n\n',
        'data: [DONE]\n\n',
      ]),
      headers: { 'content-type': 'text/event-stream' },
    });

    await expect(
      createService().generateImage('A product photograph'),
    ).resolves.toEqual({
      success: false,
      error: 'Image generation stream ended without a completed event',
      retryable: true,
    });
  });

  it('preserves an explicit provider error event', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: Readable.from([
        'event: error\n',
        'data: {"type":"error","error":{"message":"No available compatible accounts"}}\n\n',
      ]),
      headers: { 'content-type': 'text/event-stream' },
    });

    await expect(
      createService().generateImage('A product photograph'),
    ).resolves.toEqual({
      success: false,
      error: 'No available compatible accounts',
      retryable: false,
    });
  });

  it('marks malformed SSE event data as retryable', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: Readable.from([
        'data: {"type":"image_generation.completed","b64_json":\n\n',
      ]),
      headers: { 'content-type': 'text/event-stream' },
    });

    await expect(
      createService().generateImage('A product photograph'),
    ).resolves.toEqual({
      success: false,
      error: 'Image generation stream returned invalid event data',
      retryable: true,
    });
  });

  it.each([
    [401, false],
    [429, true],
    [503, true],
  ])(
    'preserves a streamed HTTP %s provider error and its retry classification',
    async (status, retryable) => {
      jest
        .spyOn(axios, 'post')
        .mockRejectedValue(streamingAxiosFailure(status, `provider ${status}`));

      await expect(
        createService().generateImage('A product photograph'),
      ).resolves.toEqual({
        success: false,
        error: `provider ${status}`,
        retryable,
      });
    },
  );

  it('accepts the completed image-edit event for reference images', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: Readable.from([
        'event: image_edit.completed\n',
        `data: {"b64_json":"${PNG.toString('base64')}"}\n\n`,
      ]),
      headers: { 'content-type': 'text/event-stream' },
    });

    const result = await createService().generateImage(
      'Keep the composition',
      'gpt-image-2',
      '1024x1024',
      {
        file: {
          buffer: PNG,
          mimetype: 'image/png',
          originalname: 'reference.png',
        },
      },
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.imageBuffer).toEqual(PNG);
    }
  });

  it('rejects a completed event containing an invalid image', async () => {
    const invalidImage = Buffer.from('not-an-image').toString('base64');
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: Readable.from([
        `data: {"type":"image_generation.completed","b64_json":"${invalidImage}"}\n\n`,
      ]),
      headers: { 'content-type': 'text/event-stream' },
    });

    await expect(
      createService().generateImage('A product photograph'),
    ).resolves.toEqual({
      success: false,
      error: 'Image generation API returned an unsupported image format',
      retryable: false,
    });
  });

  it('rejects syntactically invalid Base64 without accepting a valid prefix', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: Readable.from([
        `data: {"type":"image_generation.completed","b64_json":"${PNG.toString('base64')}%%%"}\n\n`,
      ]),
      headers: { 'content-type': 'text/event-stream' },
    });

    await expect(
      createService().generateImage('A product photograph'),
    ).resolves.toEqual({
      success: false,
      error: 'Image generation API returned invalid base64 image data',
      retryable: true,
    });
  });

  it('marks a connection reset during the stream as retryable without resending', async () => {
    const stream = new Readable({
      read() {
        this.push(
          'data: {"type":"image_generation.partial_image","partial_image_index":0}\n\n',
        );
        this.destroy(
          Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        );
      },
    });
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: stream,
      headers: { 'content-type': 'text/event-stream' },
    });

    await expect(
      createService().generateImage('A product photograph'),
    ).resolves.toEqual({
      success: false,
      error: 'socket hang up',
      retryable: true,
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('consumes a real Axios SSE response before the server closes it', async () => {
    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const event = `data: {"type":"image_generation.completed","b64_json":"${PNG.toString('base64')}"}\n\n`;
      const splitAt = Math.floor(event.length / 2);
      response.write(event.slice(0, splitAt));
      setImmediate(() => response.write(event.slice(splitAt)));
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    let timeout: NodeJS.Timeout | undefined;
    try {
      const port = (server.address() as AddressInfo).port;
      const result = await Promise.race([
        createService({
          AI_LINE_A_BASE_URL: `http://127.0.0.1:${port}`,
        }).generateImage('A product photograph'),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('SSE response waited for connection EOF')),
            2000,
          );
        }),
      ]);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.imageBuffer).toEqual(PNG);
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
