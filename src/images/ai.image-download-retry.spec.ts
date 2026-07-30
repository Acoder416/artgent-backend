import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AiService } from './ai.service';

describe('AiService generated image download retryability', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('retries an HTTP 429 while downloading a generated image', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: { data: [{ url: 'https://static.test/result.png' }] },
    });
    const get = jest
      .spyOn(axios, 'get')
      .mockRejectedValueOnce(
        Object.assign(new Error('rate limited'), {
          isAxiosError: true,
          response: { status: 429 },
        }),
      )
      .mockResolvedValueOnce({ data: png });
    const service = new AiService(
      new ConfigService({
        AI_LINE_A_BASE_URL: 'https://gateway.test',
        AI_LINE_B_BASE_URL: 'https://gateway.test',
        SUB2API_KEY: 'test-key',
      }),
    );

    const result = await service.generateImage(
      'A studio product photograph',
      'gpt-image-2',
      '1024x1024',
    );

    expect(result.success).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
