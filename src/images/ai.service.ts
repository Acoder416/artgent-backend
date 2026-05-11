import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface GenerateImageResult {
  success: boolean;
  imageBuffer?: Buffer;
  error?: string;
}

interface OpenAIImageResponse {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
  error?: {
    message?: string;
  };
}

interface OpenAIModelsResponse {
  data?: Array<{
    id?: string;
  }>;
}

const fallbackImageModels = [
  'gpt-image-1',
  'gpt-image-1-mini',
  'gpt-image-1.5',
  'gpt-image-2',
  'gemini-2.0-flash-exp-image-generation',
  'gemini-2.5-flash-image',
  'gemini-3-pro-image-preview',
  'gemini-3.1-flash-image',
];

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private baseUrl: string;
  private apiKey: string;

  constructor(private configService: ConfigService) {
    this.baseUrl = this.configService.get('SUB2API_BASE_URL', 'http://127.0.0.1:9099');
    this.apiKey = this.configService.get('SUB2API_KEY', '');
  }

  async listImageModels(): Promise<string[]> {
    if (!this.apiKey) {
      return fallbackImageModels;
    }

    try {
      const response = await axios.get<OpenAIModelsResponse>(`${this.baseUrl}/v1/models`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        timeout: 30000,
      });

      const models = (response.data?.data || [])
        .map((model) => model.id)
        .filter((id): id is string => Boolean(id))
        .filter((id) => fallbackImageModels.includes(id) || id.includes('image'));

      return models.length > 0 ? models : fallbackImageModels;
    } catch (error) {
      this.logger.warn(`Failed to fetch image models: ${error.message}`);
      return fallbackImageModels;
    }
  }

  async generateImage(
    prompt: string,
    model: string = 'gpt-image-1',
    size: string = '1024x1024',
  ): Promise<GenerateImageResult> {
    this.logger.log(`Generating image: model=${model}, prompt="${prompt.slice(0, 50)}..."`);

    try {
      if (!this.apiKey) {
        return {
          success: false,
          error: 'Sub2API key is not configured',
        };
      }

      const response = await axios.post<OpenAIImageResponse>(
        `${this.baseUrl}/v1/images/generations`,
        {
          model,
          prompt,
          n: 1,
          size,
          response_format: 'b64_json',
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 120000,
        },
      );

      const image = response.data?.data?.[0];
      if (image?.b64_json) {
        return {
          success: true,
          imageBuffer: Buffer.from(image.b64_json, 'base64'),
        };
      }

      if (image?.url) {
        const imageResponse = await axios.get<ArrayBuffer>(image.url, {
          responseType: 'arraybuffer',
          timeout: 120000,
        });

        return {
          success: true,
          imageBuffer: Buffer.from(imageResponse.data),
        };
      }

      return {
        success: false,
        error: response.data?.error?.message || 'Image generation API returned no image',
      };
    } catch (error) {
      this.logger.error(`Image generation failed: ${error.message}`);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message || 'Image generation failed',
      };
    }
  }
}
