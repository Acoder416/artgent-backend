import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { REAL_PNG_3X2 } from '../test/image-fixtures';
import { AiService } from './ai.service';

function createService(): AiService {
  return new AiService(
    new ConfigService({
      AI_LINE_A_BASE_URL: 'https://gateway.test',
      AI_LINE_A_API_KEY: 'line-a-key',
      AI_LINE_B_BASE_URL: 'https://gateway.test',
      AI_LINE_B_API_KEY: 'line-b-key',
    }),
  );
}

describe('AiService generated image URL SSRF protection', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects a provider image URL that targets a private address', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        data: [{ url: 'http://169.254.169.254/latest/meta-data' }],
      },
    });
    const get = jest.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: REAL_PNG_3X2,
    });

    const result = await createService().generateImage(
      'A safe deployment test image',
      'gpt-image-2',
      '1024x1024',
      undefined,
      'line-a',
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unsafe generated image URL/i);
    expect(get).not.toHaveBeenCalled();
  });

  it('revalidates a redirect before following it', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        data: [{ url: 'https://gateway.test/generated/result.png' }],
      },
    });
    const get = jest.spyOn(axios, 'get').mockResolvedValue({
      status: 302,
      headers: { location: 'http://127.0.0.1:9000/private.png' },
      data: new ArrayBuffer(0),
    });

    const result = await createService().generateImage(
      'A safe deployment redirect test',
      'gpt-image-2',
      '1024x1024',
      undefined,
      'line-a',
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unsafe generated image URL/i);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
