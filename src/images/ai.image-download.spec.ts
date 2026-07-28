import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AiService } from './ai.service';

describe('AiService image URL download', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('retries a transient TLS disconnect returned by the image gateway', async () => {
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
      .mockResolvedValueOnce({ data: Buffer.from('generated-image') });
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
      imageBuffer: Buffer.from('generated-image'),
    });
    expect(get).toHaveBeenCalledTimes(2);
  });
});
