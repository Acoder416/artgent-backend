import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createHash } from 'node:crypto';
import { REAL_PNG_3X2, REAL_WEBP_3X2 } from '../test/image-fixtures';
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
    const webp = REAL_WEBP_3X2;
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
      width: 3,
      height: 2,
      sha256: createHash('sha256').update(webp).digest('hex'),
    });
  });

  it('returns the actual dimensions when the provider image header contains them', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: { data: [{ b64_json: REAL_PNG_3X2.toString('base64') }] },
    });

    const result = await createService().generateImage(
      'A studio product photograph',
      'gpt-image-2',
      '1024x1024',
    );

    expect(result).toMatchObject({
      success: true,
      width: 3,
      height: 2,
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

  it('rejects a truncated recognized signature as an unsupported image', async () => {
    const truncatedPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: { data: [{ b64_json: truncatedPng.toString('base64') }] },
    });

    await expect(
      createService().generateImage(
        'A studio product photograph',
        'gpt-image-2',
        '1024x1024',
      ),
    ).resolves.toEqual({
      success: false,
      error: 'Image generation API returned an unsupported image format',
      retryable: false,
    });
  });

  it('rejects a PNG with a valid IHDR but no image data or end chunk', async () => {
    const ihdrOnlyPng = REAL_PNG_3X2.subarray(0, 33);
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: { data: [{ b64_json: ihdrOnlyPng.toString('base64') }] },
    });

    const result = await createService().generateImage(
      'A studio product photograph',
      'gpt-image-2',
      '1024x1024',
    );

    expect(result).toMatchObject({ success: false, retryable: false });
  });
});
