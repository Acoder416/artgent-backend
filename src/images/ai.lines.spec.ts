import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { REAL_PNG_3X2 } from '../test/image-fixtures';
import { AiService } from './ai.service';

describe('AiService line routing', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the selected line URL and credentials for generation', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        data: [{ b64_json: REAL_PNG_3X2.toString('base64') }],
      },
    });
    const service = new AiService(
      new ConfigService({
        AI_LINE_A_BASE_URL: 'https://line-a.test',
        AI_LINE_A_API_KEY: 'line-a-key',
        AI_LINE_B_BASE_URL: 'https://line-b.test',
        AI_LINE_B_API_KEY: 'line-b-key',
      }),
    );

    const result = await service.generateImage(
      'A campaign image',
      'gpt-image-2',
      '1024x1024',
      undefined,
      'line-b',
    );

    expect(result.success).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    const [url, , requestConfig] = post.mock.calls[0];
    expect(url).toBe('https://line-b.test/v1/images/generations');
    expect(requestConfig?.headers).toMatchObject({
      Authorization: 'Bearer line-b-key',
    });
  });

  it('exposes each line concurrency limit to the queue scheduler', () => {
    const service = new AiService(
      new ConfigService({
        AI_LINE_A_BASE_URL: 'https://line-a.test',
        AI_LINE_A_API_KEY: 'line-a-key',
        AI_LINE_B_BASE_URL: 'https://line-b.test',
        AI_LINE_B_API_KEY: 'line-b-key',
      }),
    );

    expect(service.getLineMaxConcurrency('line-a')).toBe(3);
    expect(service.getLineMaxConcurrency('line-b')).toBe(10);
  });
});
