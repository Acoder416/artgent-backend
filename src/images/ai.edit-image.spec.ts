import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AiService } from './ai.service';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
      undefined,
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
    expect((data as FormData).has('aspectRatio')).toBe(false);
    expect((data as FormData).has('aspect_ratio')).toBe(false);
    expect((data as FormData).has('response_format')).toBe(false);
    expect(config?.headers).toEqual({
      Authorization: 'Bearer test-key',
    });
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
