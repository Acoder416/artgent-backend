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
    });

    expect(prompt).toBe('A precise editorial photograph with soft side light.');
    expect(post).toHaveBeenCalledWith(
      'https://gateway.test/v1/chat/completions',
      expect.objectContaining({
        model: 'test-chat-model',
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'system' }),
          expect.objectContaining({ role: 'user' }),
        ]),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
      }),
    );
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
