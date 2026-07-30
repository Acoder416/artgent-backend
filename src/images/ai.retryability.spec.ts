import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AiService } from './ai.service';

function createService(apiKey = 'test-key') {
  return new AiService(
    new ConfigService({
      AI_LINE_A_BASE_URL: 'https://gateway.test',
      AI_LINE_B_BASE_URL: 'https://gateway.test',
      SUB2API_KEY: apiKey,
    }),
  );
}

function axiosFailure(status?: number, code?: string) {
  return Object.assign(new Error('provider failure'), {
    isAxiosError: true,
    code,
    response:
      status === undefined
        ? undefined
        : {
            status,
            data: { error: { message: 'provider failure' } },
          },
  });
}

describe('AiService generation retryability', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['a reset connection', undefined, 'ECONNRESET', true],
    ['HTTP 408', 408, undefined, true],
    ['HTTP 429', 429, undefined, true],
    ['HTTP 503', 503, undefined, true],
    ['HTTP 400', 400, undefined, false],
    ['HTTP 401', 401, undefined, false],
    ['HTTP 404', 404, undefined, false],
  ])('classifies %s', async (_label, status, code, expectedRetryable) => {
    jest.spyOn(axios, 'post').mockRejectedValue(axiosFailure(status, code));

    const result = await createService().generateImage(
      'A studio product photograph',
      'gpt-image-2',
      '1024x1024',
    );

    expect(result).toEqual({
      success: false,
      error: 'provider failure',
      retryable: expectedRetryable,
    });
  });

  it('does not retry when the selected line has no API key', async () => {
    await expect(
      createService('').generateImage(
        'A studio product photograph',
        'gpt-image-2',
        '1024x1024',
      ),
    ).resolves.toEqual({
      success: false,
      error: 'Sub2API key is not configured',
      retryable: false,
    });
  });

  it('does not retry an unknown AI line', async () => {
    await expect(
      createService().generateImage(
        'A studio product photograph',
        'gpt-image-2',
        '1024x1024',
        undefined,
        'missing-line',
      ),
    ).resolves.toMatchObject({
      success: false,
      retryable: false,
    });
  });

  it('does not retry a successful response without an image', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({ data: { data: [] } });

    await expect(
      createService().generateImage(
        'A studio product photograph',
        'gpt-image-2',
        '1024x1024',
      ),
    ).resolves.toEqual({
      success: false,
      error: 'Image generation API returned no image',
      retryable: false,
    });
  });
});
