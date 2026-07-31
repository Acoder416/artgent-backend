import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AiService } from './ai.service';

describe('AiService cross-origin image URL download', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not expose line credentials to an external image host', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: { data: [{ url: 'https://cdn.test/result.png' }] },
    });
    const get = jest.spyOn(axios, 'get').mockResolvedValue({ data: png });
    const service = new AiService(
      new ConfigService({
        AI_LINE_A_BASE_URL: 'https://gateway.test',
        AI_LINE_A_API_KEY: 'line-a-key',
        AI_LINE_B_BASE_URL: 'https://gateway.test',
        AI_LINE_B_API_KEY: 'line-b-key',
      }),
    );

    const result = await service.generateImage(
      'An image returned by an external CDN',
      'gpt-image-2',
      '1024x1024',
      undefined,
      'line-a',
    );

    expect(result.success).toBe(true);
    expect(get).toHaveBeenCalledWith(
      'https://cdn.test/result.png',
      expect.objectContaining({ headers: undefined }),
    );
  });
});
