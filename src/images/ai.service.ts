import {
  BadRequestException,
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  detectImageMetadata,
  ImageFormat,
  ImageMimeType,
} from '../upload/image-format';
import type { AiLineId } from './ai-line';
import { AiLineConnection, loadAiLinesConfiguration } from './ai-lines.config';
import { DEFAULT_IMAGE_QUALITY, type ImageQuality } from './image-parameters';
import { ReferenceImage, UploadedImageFile } from './types/uploaded-image-file';

export type GenerateImageResult =
  | {
      success: true;
      imageBuffer: Buffer;
      mimeType: ImageMimeType;
      imageFormat: ImageFormat;
      error?: never;
    }
  | {
      success: false;
      error: string;
      retryable: boolean;
      imageBuffer?: never;
      mimeType?: never;
      imageFormat?: never;
    };

export type { AiLineId } from './ai-line';

export interface AiLineSummary {
  id: AiLineId;
  name: string;
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
  lineId?: AiLineId;
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
  private readonly connections: Map<AiLineId, AiLineConnection>;
  private readonly defaultLineId: AiLineId;
  private readonly promptRewriteModel: string;

  constructor(private configService: ConfigService) {
    const configuration = loadAiLinesConfiguration({
      projectDir: process.cwd(),
      configFile: this.configService.get<string>(
        'AI_LINES_CONFIG_FILE',
        'config/ai-lines.json',
      ),
      getEnvironmentValue: (key) => this.configService.get<string>(key),
      defaultLineOverride: this.configService.get<string>('AI_DEFAULT_LINE'),
    });
    this.defaultLineId = configuration.defaultLineId;
    this.connections = new Map(
      configuration.lines.map((connection) => [connection.id, connection]),
    );
    this.promptRewriteModel = this.configService.get(
      'PROMPT_REWRITE_MODEL',
      'gpt-5.4-mini',
    );
  }

  listLines(): { lines: AiLineSummary[]; defaultLineId: AiLineId } {
    return {
      lines: Array.from(this.connections.values(), ({ id, name }) => ({
        id,
        name,
      })),
      defaultLineId: this.defaultLineId,
    };
  }

  resolveLineId(lineId?: AiLineId): AiLineId {
    return this.resolveConnection(lineId).id;
  }

  async listImageModels(lineId?: AiLineId): Promise<string[]> {
    const connection = this.resolveConnection(lineId);
    if (!connection.apiKey) {
      return fallbackImageModels;
    }

    try {
      const response = await axios.get<OpenAIModelsResponse>(
        `${connection.baseUrl}/v1/models`,
        {
          headers: {
            Authorization: `Bearer ${connection.apiKey}`,
          },
          timeout: 30000,
        },
      );

      const models = (response.data?.data || [])
        .map((model) => model.id)
        .filter((id): id is string => Boolean(id))
        .filter((id) => fallbackImageModels.includes(id));

      return models.length > 0 ? models : fallbackImageModels;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to fetch image models: ${message}`);
      return fallbackImageModels;
    }
  }

  async generateImage(
    prompt: string,
    model: string = 'gpt-image-2',
    size: string = '1024x1024',
    referenceImage?: ReferenceImage,
    lineId?: AiLineId,
    quality: ImageQuality = DEFAULT_IMAGE_QUALITY,
  ): Promise<GenerateImageResult> {
    const referenceCount =
      (referenceImage?.files?.length || 0) +
      (referenceImage?.urls?.length || 0) +
      (referenceImage?.file ? 1 : 0) +
      (referenceImage?.url ? 1 : 0);

    try {
      const connection = this.resolveConnection(lineId);
      this.logger.log(
        `Generating image: line=${connection.id}, model=${model}, size=${size}, mode=${
          referenceCount > 0 ? 'edit' : 'generation'
        }, prompt="${prompt.slice(0, 50)}..."`,
      );

      if (!connection.apiKey) {
        return {
          success: false,
          error: 'Sub2API key is not configured',
          retryable: false,
        };
      }

      const response =
        referenceCount > 0
          ? await this.editImage(
              prompt,
              model,
              size,
              quality,
              referenceImage || {},
              connection,
            )
          : await this.createImage(prompt, model, size, quality, connection);

      return await this.extractImageBuffer(response.data, connection);
    } catch (error: unknown) {
      const message = this.generationErrorMessage(error);
      this.logger.error(`Image generation failed: ${message}`);
      return {
        success: false,
        error: message,
        retryable: this.isRetryableProviderError(error),
      };
    }
  }

  async rewritePrompt(input: RewritePromptInput): Promise<string> {
    const connection = this.resolveConnection(input.lineId);
    if (!connection.apiKey) {
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
        `${connection.baseUrl}/v1/chat/completions`,
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
            Authorization: `Bearer ${connection.apiKey}`,
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
      const message = axios.isAxiosError<OpenAIChatResponse>(error)
        ? error.response?.data?.error?.message || error.message
        : error instanceof Error
          ? error.message
          : String(error);
      this.logger.error(`Prompt rewriting failed: ${message}`);
      throw new BadGatewayException('AI 帮写暂时不可用，请稍后重试');
    }
  }

  private async createImage(
    prompt: string,
    model: string,
    size: string,
    quality: ImageQuality,
    connection: AiLineConnection,
  ) {
    return axios.post<OpenAIImageResponse>(
      `${connection.baseUrl}/v1/images/generations`,
      {
        model,
        prompt,
        n: 1,
        size,
        quality,
      },
      {
        headers: {
          Authorization: `Bearer ${connection.apiKey}`,
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
    quality: ImageQuality,
    referenceImage: ReferenceImage,
    connection: AiLineConnection,
  ) {
    const files = [
      ...(referenceImage.files || []),
      ...(referenceImage.file ? [referenceImage.file] : []),
    ];
    const urls = [
      ...(referenceImage.urls || []),
      ...(referenceImage.url ? [referenceImage.url] : []),
    ].filter(Boolean);

    if (urls.length > 0) {
      throw new BadRequestException(
        'Reference image URLs must be staged as files',
      );
    }
    if (files.length === 0) {
      throw new BadRequestException('At least one reference image is required');
    }

    const formData = new FormData();
    formData.append('model', model);
    formData.append('prompt', prompt);
    formData.append('n', '1');
    formData.append('size', size);
    formData.append('quality', quality);
    files.forEach((file, index) => {
      formData.append(
        'image',
        this.fileToBlob(file),
        file.originalname || `reference-${index + 1}.png`,
      );
    });

    return axios.post<OpenAIImageResponse>(
      `${connection.baseUrl}/v1/images/edits`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${connection.apiKey}`,
        },
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

  private async extractImageBuffer(
    response: OpenAIImageResponse,
    connection: AiLineConnection,
  ): Promise<GenerateImageResult> {
    const image = response.data?.[0];
    if (image?.b64_json) {
      return this.createGeneratedImageResult(
        Buffer.from(image.b64_json, 'base64'),
      );
    }

    if (image?.url) {
      const imageResponse = await this.downloadGeneratedImage(
        image.url,
        connection,
      );
      return this.createGeneratedImageResult(Buffer.from(imageResponse.data));
    }

    return {
      success: false,
      error:
        response.error?.message || 'Image generation API returned no image',
      retryable: false,
    };
  }

  private createGeneratedImageResult(imageBuffer: Buffer): GenerateImageResult {
    const metadata = detectImageMetadata(imageBuffer);
    if (!metadata) {
      return {
        success: false,
        error: 'Image generation API returned an unsupported image format',
        retryable: false,
      };
    }

    return {
      success: true,
      imageBuffer,
      ...metadata,
    };
  }

  private resolveConnection(lineId?: AiLineId): AiLineConnection {
    const selectedLineId = lineId || this.defaultLineId;
    const connection = this.connections.get(selectedLineId);
    if (!connection) {
      throw new BadRequestException(`Unknown AI line: ${selectedLineId}`);
    }
    return connection;
  }

  private async downloadGeneratedImage(
    imageUrl: string,
    connection: AiLineConnection,
  ) {
    const attempts = 4;
    const headers = this.isSameOrigin(imageUrl, connection.baseUrl)
      ? { Authorization: `Bearer ${connection.apiKey}` }
      : undefined;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await axios.get<ArrayBuffer>(imageUrl, {
          responseType: 'arraybuffer',
          headers,
          timeout: 120000,
        });
      } catch (error: unknown) {
        if (attempt === attempts || !this.isRetryableProviderError(error)) {
          throw error;
        }

        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Generated image download failed (${attempt}/${attempts}): ${message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }

    throw new Error('Generated image download failed');
  }

  private isSameOrigin(url: string, baseUrl: string): boolean {
    try {
      return new URL(url).origin === new URL(baseUrl).origin;
    } catch {
      return false;
    }
  }
  private isRetryableProviderError(error: unknown): boolean {
    const code =
      typeof error === 'object' && error && 'code' in error
        ? String(error.code).toUpperCase()
        : '';
    const status = axios.isAxiosError(error)
      ? error.response?.status
      : undefined;

    if (status !== undefined) {
      return (
        status === 408 || status === 429 || (status >= 500 && status < 600)
      );
    }

    return [
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNABORTED',
      'ECONNREFUSED',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ENOTFOUND',
      'EPIPE',
      'EAI_AGAIN',
      'ERR_NETWORK',
    ].includes(code);
  }

  private generationErrorMessage(error: unknown): string {
    if (axios.isAxiosError<OpenAIImageResponse>(error)) {
      return (
        error.response?.data?.error?.message ||
        error.message ||
        'Image generation failed'
      );
    }
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error) return error;
    return 'Image generation failed';
  }
}
