import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { REAL_PNG_3X2 } from '../test/image-fixtures';
import { AiService } from './ai.service';

jest.mock('node:dns/promises', () => ({
  lookup: jest
    .fn()
    .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

describe('AiService generated image download retryability', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('retries an HTTP 429 while downloading a generated image', async () => {
    const png = REAL_PNG_3X2;
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
