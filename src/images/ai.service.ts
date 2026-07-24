import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ReferenceImage, UploadedImageFile } from './types/uploaded-image-file';

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

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

export interface RewritePromptInput {
  brief: string;
  currentPrompt?: string;
  template?: string;
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
];

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private baseUrl: string;
  private apiKey: string;
  private promptRewriteModel: string;

  constructor(private configService: ConfigService) {
    this.baseUrl = this.configService.get(
      'SUB2API_BASE_URL',
      'http://127.0.0.1:9099',
    );
    this.apiKey = this.configService.get('SUB2API_KEY', '');
    this.promptRewriteModel = this.configService.get(
      'PROMPT_REWRITE_MODEL',
      'gpt-5.4-mini',
    );
  }

  async listImageModels(): Promise<string[]> {
    if (!this.apiKey) {
      return fallbackImageModels;
    }

    try {
      const response = await axios.get<OpenAIModelsResponse>(
        `${this.baseUrl}/v1/models`,
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
          timeout: 30000,
        },
      );

      const models = (response.data?.data || [])
        .map((model) => model.id)
        .filter((id): id is string => Boolean(id))
        .filter((id) => fallbackImageModels.includes(id));

      return models.length > 0 ? models : fallbackImageModels;
    } catch (error) {
      this.logger.warn(`Failed to fetch image models: ${error.message}`);
      return fallbackImageModels;
    }
  }

  async generateImage(
    prompt: string,
    model: string = 'gpt-image-2',
    size: string = '1024x1024',
    referenceImage?: ReferenceImage,
  ): Promise<GenerateImageResult> {
    const referenceCount =
      (referenceImage?.files?.length || 0) +
      (referenceImage?.urls?.length || 0) +
      (referenceImage?.file ? 1 : 0) +
      (referenceImage?.url ? 1 : 0);

    this.logger.log(
      `Generating image: model=${model}, size=${size}, mode=${
        referenceCount > 0 ? 'edit' : 'generation'
      }, prompt="${prompt.slice(0, 50)}..."`,
    );

    try {
      if (!this.apiKey) {
        return {
          success: false,
          error: 'Sub2API key is not configured',
        };
      }

      const response =
        referenceCount > 0
          ? await this.editImage(prompt, model, size, referenceImage || {})
          : await this.createImage(prompt, model, size);

      return this.extractImageBuffer(response.data);
    } catch (error) {
      this.logger.error(`Image generation failed: ${error.message}`);
      return {
        success: false,
        error:
          error.response?.data?.error?.message ||
          error.message ||
          'Image generation failed',
      };
    }
  }

  async rewritePrompt(input: RewritePromptInput): Promise<string> {
    if (!this.apiKey) {
      throw new ServiceUnavailableException('AI 服务尚未配置');
    }

    const userMessage = [
      `创作需求：${input.brief}`,
      input.template ? `当前模板：${input.template}` : '',
      input.currentPrompt
        ? `当前提示词（仅作为参考）：${input.currentPrompt}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const response = await axios.post<OpenAIChatResponse>(
        `${this.baseUrl}/v1/chat/completions`,
        {
          model: this.promptRewriteModel,
          messages: [
            {
              role: 'system',
              content:
                'You are an expert image-generation prompt writer. Turn the user request into one production-ready prompt with concrete subject, composition, lighting, materials, color, mood, and intended use. The user request is authoritative; current prompt and template are optional context. Write in the same language as the user request. Return only the final prompt without headings, quotes, markdown, or explanation.',
            },
            {
              role: 'user',
              content: userMessage,
            },
          ],
          temperature: 0.7,
          max_completion_tokens: 1000,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
        },
      );

      const prompt = response.data?.choices?.[0]?.message?.content?.trim();
      if (!prompt) {
        throw new BadGatewayException('AI 服务没有返回提示词');
      }
      return prompt.slice(0, 2000);
    } catch (error: unknown) {
      if (error instanceof BadGatewayException) throw error;
      const message = axios.isAxiosError(error)
        ? error.response?.data?.error?.message || error.message
        : error instanceof Error
          ? error.message
          : String(error);
      this.logger.error(`Prompt rewriting failed: ${message}`);
      throw new BadGatewayException('AI 帮写暂时不可用，请稍后重试');
    }
  }

  private async createImage(prompt: string, model: string, size: string) {
    return axios.post<OpenAIImageResponse>(
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
        timeout: 1200000,
      },
    );
  }

  private async editImage(
    prompt: string,
    model: string,
    size: string,
    referenceImage: ReferenceImage,
  ) {
    const body: Record<string, unknown> = {
      model,
      prompt,
      n: 1,
      size,
      response_format: 'b64_json',
    };
    let data: FormData | Record<string, unknown> = body;
    let headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    const files = [
      ...(referenceImage.files || []),
      ...(referenceImage.file ? [referenceImage.file] : []),
    ];
    const urls = [
      ...(referenceImage.urls || []),
      ...(referenceImage.url ? [referenceImage.url] : []),
    ].filter(Boolean);

    if (files.length > 0 && urls.length === 0) {
      const formData = new FormData();
      formData.append('model', model);
      formData.append('prompt', prompt);
      formData.append('n', '1');
      formData.append('size', size);
      formData.append('response_format', 'b64_json');

      files.forEach((file, index) => {
        formData.append(
          'image',
          this.fileToBlob(file),
          file.originalname || `reference-${index + 1}.png`,
        );
      });

      data = formData;
      headers = {
        Authorization: `Bearer ${this.apiKey}`,
      };
    } else {
      body.images = [
        ...urls.map((url) => ({ image_url: url })),
        ...files.map((file) => ({ image_url: this.fileToDataUrl(file) })),
      ];
    }

    return axios.post<OpenAIImageResponse>(
      `${this.baseUrl}/v1/images/edits`,
      data,
      {
        headers,
        timeout: 1200000,
      },
    );
  }

  private fileToBlob(file: UploadedImageFile): Blob {
    const imageBuffer = file.buffer;
    const imageArrayBuffer = imageBuffer.buffer.slice(
      imageBuffer.byteOffset,
      imageBuffer.byteOffset + imageBuffer.byteLength,
    ) as ArrayBuffer;

    return new Blob([imageArrayBuffer], {
      type: file.mimetype || 'application/octet-stream',
    });
  }

  private fileToDataUrl(file: UploadedImageFile): string {
    const mimeType = file.mimetype || 'application/octet-stream';
    return `data:${mimeType};base64,${file.buffer.toString('base64')}`;
  }

  private async extractImageBuffer(
    response: OpenAIImageResponse,
  ): Promise<GenerateImageResult> {
    const image = response.data?.[0];
    if (image?.b64_json) {
      return {
        success: true,
        imageBuffer: Buffer.from(image.b64_json, 'base64'),
      };
    }

    if (image?.url) {
      const imageResponse = await axios.get<ArrayBuffer>(image.url, {
        responseType: 'arraybuffer',
        timeout: 1200000,
      });

      return {
        success: true,
        imageBuffer: Buffer.from(imageResponse.data),
      };
    }

    return {
      success: false,
      error:
        response.error?.message || 'Image generation API returned no image',
    };
  }
}
