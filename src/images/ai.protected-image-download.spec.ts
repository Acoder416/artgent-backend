import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { REAL_PNG_3X2 } from '../test/image-fixtures';
import { AiService } from './ai.service';

describe('AiService protected image URL download', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('forwards the selected line credentials to the image download', async () => {
    const png = REAL_PNG_3X2;
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        data: [
          {
            url: 'https://gateway.test/v1/files/generated/result.png',
          },
        ],
      },
    });
    const get = jest.spyOn(axios, 'get').mockImplementation((_url, config) => {
      if (config?.headers?.Authorization !== 'Bearer line-a-key') {
        return Promise.reject(
          Object.assign(new Error('Request failed with status code 401'), {
            isAxiosError: true,
            response: {
              status: 401,
              data: {
                error: {
                  message: 'Valid and authorized credentials required',
                },
              },
            },
          }),
        );
      }
      return Promise.resolve({ data: png });
    });
    const service = new AiService(
      new ConfigService({
        AI_LINE_A_BASE_URL: 'https://gateway.test',
        AI_LINE_A_API_KEY: 'line-a-key',
        AI_LINE_B_BASE_URL: 'https://gateway.test',
        AI_LINE_B_API_KEY: 'line-b-key',
      }),
    );

    const result = await service.generateImage(
      'A protected generated image download',
      'gpt-image-2',
      '1024x1024',
      undefined,
      'line-a',
    );

    expect(result).toMatchObject({
      success: true,
      imageBuffer: png,
      mimeType: 'image/png',
      imageFormat: 'png',
    });
    expect(get).toHaveBeenCalledTimes(1);
  });
});
