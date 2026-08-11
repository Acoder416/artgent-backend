import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { REAL_PNG_3X2 } from '../test/image-fixtures';
import { AiService } from './ai.service';

const PNG = REAL_PNG_3X2;

function createService() {
  return new AiService(
    new ConfigService({
      AI_LINE_A_BASE_URL: 'https://gateway.test',
      AI_LINE_A_API_KEY: 'test-key',
      AI_LINE_B_BASE_URL: 'https://gateway.test',
      AI_LINE_B_API_KEY: 'test-key',
    }),
  );
}

describe('AiService image edit request encoding', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates multipart blobs without an intermediate ArrayBuffer copy', async () => {
    const service = createService();
    const backing = Buffer.concat([
      Buffer.from([1, 2]),
      PNG,
      Buffer.from([3, 4]),
    ]);
    const bounded = backing.subarray(2, 2 + PNG.length);
    const serviceWithFileToBlob = service as unknown as {
      fileToBlob: (file: {
        buffer: Buffer;
        mimetype: string;
        originalname: string;
      }) => Blob;
    };
    expect(String(serviceWithFileToBlob.fileToBlob)).not.toContain('.slice(');

    const blob = serviceWithFileToBlob.fileToBlob({
      buffer: bounded,
      mimetype: 'image/png',
      originalname: 'reference.png',
    });

    expect(Buffer.from(await blob.arrayBuffer())).toEqual(PNG);
  });

  it('sends reference files through multipart image fields', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: { data: [{ b64_json: PNG.toString('base64') }] },
    });

    const result = await createService().generateImage(
      'Keep the composition',
      'gpt-image-2',
      '1600x2000',
      {
        files: [
          {
            buffer: PNG,
            mimetype: 'image/png',
            originalname: 'reference.png',
          },
        ],
      },
      'line-b',
      'medium',
    );

    expect(result.success).toBe(true);
    const [url, data, config] = post.mock.calls[0];
    expect(url).toBe('https://gateway.test/v1/images/edits');
    expect(data).toBeInstanceOf(FormData);
    expect((data as FormData).getAll('image')).toHaveLength(1);
    expect((data as FormData).get('size')).toBe('1600x2000');
    expect((data as FormData).get('quality')).toBe('medium');
    expect((data as FormData).get('n')).toBe('1');
    expect((data as FormData).get('stream')).toBe('true');
    expect((data as FormData).get('partial_images')).toBe('0');
    expect((data as FormData).has('aspectRatio')).toBe(false);
    expect((data as FormData).has('aspect_ratio')).toBe(false);
    expect((data as FormData).has('response_format')).toBe(false);
    expect(config).toMatchObject({
      headers: {
        Authorization: 'Bearer test-key',
        Accept: 'text/event-stream',
      },
      responseType: 'stream',
    });
  });

  it('sends line-a edits as non-streaming multipart requests', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: { data: [{ b64_json: PNG.toString('base64') }] },
    });

    const result = await createService().generateImage(
      'Keep the composition',
      'gpt-image-2',
      '1600x2000',
      {
        file: {
          buffer: PNG,
          mimetype: 'image/png',
          originalname: 'reference.png',
        },
      },
      'line-a',
      'medium',
    );

    expect(result.success).toBe(true);
    const [, data, config] = post.mock.calls[0];
    expect(data).toBeInstanceOf(FormData);
    expect((data as FormData).get('response_format')).toBe('b64_json');
    expect((data as FormData).get('history_disabled')).toBe('true');
    expect((data as FormData).has('stream')).toBe(false);
    expect((data as FormData).has('partial_images')).toBe(false);
    expect(config).toMatchObject({
      headers: {
        Authorization: 'Bearer test-key',
      },
    });
    expect(config?.headers).not.toHaveProperty('Accept');
    expect(config).not.toHaveProperty('responseType');
  });

  it('forwards an optional mask through the multipart mask field', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: { data: [{ b64_json: PNG.toString('base64') }] },
    });

    const result = await createService().generateImage(
      'Replace only the transparent area',
      'gpt-image-2',
      '1024x1024',
      {
        file: {
          buffer: PNG,
          mimetype: 'image/png',
          originalname: 'reference.png',
        },
        mask: {
          buffer: PNG,
          mimetype: 'image/png',
          originalname: 'mask.png',
        },
      },
      'line-a',
    );

    expect(result.success).toBe(true);
    const [, data] = post.mock.calls[0];
    expect(data).toBeInstanceOf(FormData);
    expect((data as FormData).getAll('image')).toHaveLength(1);
    expect((data as FormData).getAll('mask')).toHaveLength(1);
    expect(((data as FormData).get('mask') as File).name).toBe('mask.png');
  });

  it('rejects a mask when no reference image is provided', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: { data: [{ b64_json: PNG.toString('base64') }] },
    });

    const result = await createService().generateImage(
      'Replace only the transparent area',
      'gpt-image-2',
      '1024x1024',
      {
        mask: {
          buffer: PNG,
          mimetype: 'image/png',
          originalname: 'mask.png',
        },
      },
      'line-a',
    );

    expect(result).toEqual({
      success: false,
      error: 'A mask requires a reference image',
      retryable: false,
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('never sends URL references as a non-standard JSON images payload', async () => {
    const post = jest.spyOn(axios, 'post');

    const result = await createService().generateImage(
      'Keep the composition',
      'gpt-image-2',
      '1024x1024',
      { url: 'https://static.test/artgen/images/7/reference.png' },
    );

    expect(result).toEqual({
      success: false,
      error: 'Reference image URLs must be staged as files',
      retryable: false,
    });
    expect(post).not.toHaveBeenCalled();
  });
});
