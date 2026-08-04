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
    });
    expect(payload).not.toHaveProperty('aspectRatio');
    expect(payload).not.toHaveProperty('aspect_ratio');
    expect(payload).not.toHaveProperty('response_format');
  });
});
