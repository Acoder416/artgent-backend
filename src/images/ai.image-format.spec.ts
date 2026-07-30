import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AiService } from './ai.service';

function createService() {
  return new AiService(
    new ConfigService({
      AI_LINE_A_BASE_URL: 'https://gateway.test',
      AI_LINE_B_BASE_URL: 'https://gateway.test',
      SUB2API_KEY: 'test-key',
    }),
  );
}

describe('AiService generated image metadata', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the actual format of a base64 image', async () => {
    const webp = Buffer.from('524946460000000057454250', 'hex');
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: { data: [{ b64_json: webp.toString('base64') }] },
    });

    const result = await createService().generateImage(
      'A studio product photograph',
      'gpt-image-2',
      '1024x1024',
    );

    expect(result).toEqual({
      success: true,
      imageBuffer: webp,
      mimeType: 'image/webp',
      imageFormat: 'webp',
    });
  });

  it('rejects a provider payload that is not a supported image', async () => {
    const invalidPayload = Buffer.from('<html>gateway error</html>');
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        data: [{ b64_json: invalidPayload.toString('base64') }],
      },
    });

    const result = await createService().generateImage(
      'A studio product photograph',
      'gpt-image-2',
      '1024x1024',
    );

    expect(result).toEqual({
      success: false,
      error: 'Image generation API returned an unsupported image format',
      retryable: false,
    });
  });
});
