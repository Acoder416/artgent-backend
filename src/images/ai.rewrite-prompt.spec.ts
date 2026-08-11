import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AiService } from './ai.service';

describe('AiService prompt rewriting', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the configured chat model and returns the generated prompt', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        choices: [
          {
            message: {
              content: 'A precise editorial photograph with soft side light.',
            },
          },
        ],
      },
    });
    const service = new AiService(
      new ConfigService({
        AI_LINE_A_BASE_URL: 'https://gateway.test',
        AI_LINE_B_BASE_URL: 'https://gateway.test',
        SUB2API_KEY: 'test-key',
        PROMPT_REWRITE_MODEL: 'test-chat-model',
      }),
    );

    const prompt = await service.rewritePrompt({
      brief: 'Make a launch image for a premium camera',
      currentPrompt: 'A camera on a table',
      template: 'Product campaign',
      lineId: 'line-b',
    });

    expect(prompt).toBe('A precise editorial photograph with soft side light.');
    const [url, payload, requestConfig] = post.mock.calls[0] as unknown as [
      string,
      { model?: string; messages?: Array<{ role?: string }> },
      { headers?: Record<string, string> },
    ];
    expect(url).toBe('https://gateway.test/v1/chat/completions');
    expect(payload.model).toBe('test-chat-model');
    expect(payload.messages?.map((message) => message.role)).toEqual([
      'system',
      'user',
    ]);
    expect(requestConfig.headers?.Authorization).toBe('Bearer test-key');
  });

  it('uses line-a prompt rewriting while line-b inherits the global model', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        choices: [{ message: { content: 'A rewritten prompt.' } }],
      },
    });
    const service = new AiService(
      new ConfigService({
        AI_LINE_A_BASE_URL: 'https://gateway.test',
        AI_LINE_B_BASE_URL: 'https://gateway.test',
        SUB2API_KEY: 'test-key',
        PROMPT_REWRITE_MODEL: 'global-chat-model',
      }),
    );

    await service.rewritePrompt({
      brief: 'Write an A-line prompt',
      lineId: 'line-a',
    });
    await service.rewritePrompt({
      brief: 'Write a B-line prompt',
      lineId: 'line-b',
    });

    expect(
      post.mock.calls.map(
        ([, payload]) => (payload as { model?: string }).model,
      ),
    ).toEqual(['gpt-5-5', 'global-chat-model']);
  });

  it('does not fall back to fixed copy when the AI key is missing', async () => {
    const service = new AiService(
      new ConfigService({
        AI_LINE_A_BASE_URL: 'https://gateway.test',
        AI_LINE_B_BASE_URL: 'https://gateway.test',
        SUB2API_KEY: '',
      }),
    );

    await expect(
      service.rewritePrompt({ brief: 'Write a product prompt' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
