import { ConfigService } from '@nestjs/config';
import axios from 'axios';
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

describe('AiService image generation request parameters', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends only the concrete size and quality to the generation endpoint', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: { data: [{ b64_json: PNG.toString('base64') }] },
    });

    const result = await createService().generateImage(
      'A product photograph',
      'gpt-image-2',
      '2560x3200',
      undefined,
      undefined,
      'high',
    );

    expect(result.success).toBe(true);
    const [url, payload] = post.mock.calls[0];
    expect(url).toBe('https://gateway.test/v1/images/generations');
    expect(payload).toEqual({
      model: 'gpt-image-2',
      prompt: 'A product photograph',
      n: 1,
      size: '2560x3200',
      quality: 'high',
      stream: true,
      partial_images: 0,
    });
    expect(post.mock.calls[0][2]).toMatchObject({
      headers: {
        Authorization: 'Bearer test-key',
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      responseType: 'stream',
    });
    expect(payload).not.toHaveProperty('aspectRatio');
    expect(payload).not.toHaveProperty('aspect_ratio');
    expect(payload).not.toHaveProperty('response_format');
  });

  it('restores the JSON request shape when server-side streaming is disabled', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: { data: [{ b64_json: PNG.toString('base64') }] },
    });

    const result = await createService({
      IMAGE_STREAM_ENABLED: 'false',
    }).generateImage('A product photograph', 'gpt-image-2', '1024x1024');

    expect(result.success).toBe(true);
    const [, payload, config] = post.mock.calls[0];
    expect(payload).toEqual({
      model: 'gpt-image-2',
      prompt: 'A product photograph',
      n: 1,
      size: '1024x1024',
      quality: 'auto',
    });
    expect(config).toMatchObject({
      headers: {
        Authorization: 'Bearer test-key',
        'Content-Type': 'application/json',
      },
    });
    expect(config?.headers).not.toHaveProperty('Accept');
    expect(config).not.toHaveProperty('responseType');
  });

  it('keeps partial images fixed at zero when a non-zero value is configured', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: { data: [{ b64_json: PNG.toString('base64') }] },
    });

    const result = await createService({
      IMAGE_PARTIAL_IMAGES: 3,
    }).generateImage('A product photograph', 'gpt-image-2', '1024x1024');

    expect(result.success).toBe(true);
    expect(post.mock.calls[0][1]).toMatchObject({
      stream: true,
      partial_images: 0,
    });
  });

  it('rejects an invalid streaming flag instead of silently enabling it', () => {
    expect(() => createService({ IMAGE_STREAM_ENABLED: 'flase' })).toThrow(
      'IMAGE_STREAM_ENABLED must be true or false',
    );
  });
});
