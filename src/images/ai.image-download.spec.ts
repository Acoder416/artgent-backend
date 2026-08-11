import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { REAL_PNG_3X2 } from '../test/image-fixtures';
import { AiService } from './ai.service';

jest.mock('node:dns/promises', () => ({
  lookup: jest
    .fn()
    .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

describe('AiService image URL download', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('retries a transient TLS disconnect returned by the image gateway', async () => {
    const png = REAL_PNG_3X2;
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        data: [
          {
            url: 'https://static.example.com/artgen/images/6/result.png',
          },
        ],
      },
    });
    const get = jest
      .spyOn(axios, 'get')
      .mockRejectedValueOnce(
        Object.assign(
          new Error(
            'Client network socket disconnected before secure TLS connection was established',
          ),
          { code: 'ECONNRESET' },
        ),
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
      'A precise editorial product photograph',
      'gpt-image-2',
      '1024x1024',
    );

    expect(result).toMatchObject({
      success: true,
      imageBuffer: png,
      mimeType: 'image/png',
      imageFormat: 'png',
    });
    expect(get).toHaveBeenCalledTimes(2);
    for (const [, config] of get.mock.calls) {
      expect(config).toMatchObject({
        responseType: 'arraybuffer',
        maxContentLength: 20 * 1024 * 1024,
      });
    }
  });
});
