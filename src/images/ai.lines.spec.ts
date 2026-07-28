import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AiService } from './ai.service';

describe('AiService line routing', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the selected line URL and credentials for generation', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        data: [{ b64_json: Buffer.from('image').toString('base64') }],
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
    expect(post).toHaveBeenCalledWith(
      'https://line-b.test/v1/images/generations',
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer line-b-key',
        }),
      }),
    );
  });
});
