import {
  BadRequestException,
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { type AxiosResponse } from 'axios';
import { createParser } from 'eventsource-parser';
import { Readable } from 'node:stream';
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

interface OpenAIImageStreamEvent {
  type?: string;
  message?: string;
  b64_json?: string;
  url?: string;
  error?: {
    message?: string;
  };
}

class ImageStreamError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ImageStreamError';
  }
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
const IMAGE_PARTIAL_IMAGES = 0;

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly connections: Map<AiLineId, AiLineConnection>;
  private readonly defaultLineId: AiLineId;
  private readonly promptRewriteModel: string;
  private readonly imageStreamEnabled: boolean;

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
    const streamEnabled = this.configService.get<string | boolean>(
      'IMAGE_STREAM_ENABLED',
      true,
    );
    if (typeof streamEnabled === 'boolean') {
      this.imageStreamEnabled = streamEnabled;
    } else {
      const normalizedStreamEnabled = streamEnabled.trim().toLowerCase();
      const enabledValues = ['1', 'true', 'on', 'yes'];
      const disabledValues = ['0', 'false', 'off', 'no'];
      if (
        !enabledValues.includes(normalizedStreamEnabled) &&
        !disabledValues.includes(normalizedStreamEnabled)
      ) {
        throw new Error('IMAGE_STREAM_ENABLED must be true or false');
      }
      this.imageStreamEnabled = enabledValues.includes(normalizedStreamEnabled);
    }
    const configuredPartialImages = Number(
      this.configService.get<string | number>(
        'IMAGE_PARTIAL_IMAGES',
        IMAGE_PARTIAL_IMAGES,
      ),
    );
    if (configuredPartialImages !== IMAGE_PARTIAL_IMAGES) {
      this.logger.warn(
        'IMAGE_PARTIAL_IMAGES is fixed at 0; ignoring configured value',
      );
    }
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

      return await this.extractImageResponse(response, connection);
    } catch (error: unknown) {
      const message = await this.generationErrorMessage(error);
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
    return axios.post<OpenAIImageResponse | Readable>(
      `${connection.baseUrl}/v1/images/generations`,
      {
        model,
        prompt,
        n: 1,
        size,
        quality,
        ...(this.imageStreamEnabled
          ? {
              stream: true,
              partial_images: IMAGE_PARTIAL_IMAGES,
            }
          : {}),
      },
      {
        headers: {
          Authorization: `Bearer ${connection.apiKey}`,
          'Content-Type': 'application/json',
          ...(this.imageStreamEnabled ? { Accept: 'text/event-stream' } : {}),
        },
        timeout: 1200000,
        ...(this.imageStreamEnabled ? { responseType: 'stream' as const } : {}),
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
    if (this.imageStreamEnabled) {
      formData.append('stream', 'true');
      formData.append('partial_images', String(IMAGE_PARTIAL_IMAGES));
    }
    files.forEach((file, index) => {
      formData.append(
        'image',
        this.fileToBlob(file),
        file.originalname || `reference-${index + 1}.png`,
      );
    });

    return axios.post<OpenAIImageResponse | Readable>(
      `${connection.baseUrl}/v1/images/edits`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${connection.apiKey}`,
          ...(this.imageStreamEnabled ? { Accept: 'text/event-stream' } : {}),
        },
        timeout: 1200000,
        ...(this.imageStreamEnabled ? { responseType: 'stream' as const } : {}),
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
      const imageBuffer = this.decodeBase64Image(image.b64_json);
      if (!imageBuffer) {
        return {
          success: false,
          error: 'Image generation API returned invalid base64 image data',
          retryable: true,
        };
      }

      return this.createGeneratedImageResult(imageBuffer);
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

  private async extractImageResponse(
    response: AxiosResponse<OpenAIImageResponse | Readable>,
    connection: AiLineConnection,
  ): Promise<GenerateImageResult> {
    if (!(response.data instanceof Readable)) {
      return this.extractImageBuffer(response.data, connection);
    }

    const rawContentType = response.headers?.['content-type'];
    const contentType =
      typeof rawContentType === 'string' ? rawContentType.toLowerCase() : '';
    if (contentType.includes('application/json')) {
      const jsonResponse = await this.readJsonStream(response.data);
      return this.extractImageBuffer(jsonResponse, connection);
    }

    return this.extractSseImageResponse(response.data, connection);
  }

  private async readJsonStream(stream: Readable): Promise<OpenAIImageResponse> {
    const chunks: Buffer[] = [];
    let byteLength = 0;

    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk));
      byteLength += buffer.byteLength;
      if (byteLength > 128 * 1024 * 1024) {
        stream.destroy();
        throw new Error('Image generation API response exceeded 128 MB');
      }
      chunks.push(buffer);
    }

    return JSON.parse(
      Buffer.concat(chunks).toString('utf8'),
    ) as OpenAIImageResponse;
  }

  private async extractSseImageResponse(
    stream: Readable,
    connection: AiLineConnection,
  ): Promise<GenerateImageResult> {
    let completedResponse: OpenAIImageResponse | undefined;
    const parser = createParser({
      onEvent: (event) => {
        if (!event.data || event.data === '[DONE]') return;

        let payload: OpenAIImageStreamEvent;
        try {
          payload = JSON.parse(event.data) as OpenAIImageStreamEvent;
        } catch {
          throw new ImageStreamError(
            'Image generation stream returned invalid event data',
            true,
          );
        }
        const eventType = payload.type || event.event;
        if (eventType === 'error') {
          throw new ImageStreamError(
            payload.error?.message ||
              payload.message ||
              'Image generation API returned an error event',
            false,
          );
        }
        if (
          eventType !== 'image_generation.completed' &&
          eventType !== 'image_edit.completed'
        ) {
          return;
        }

        completedResponse = {
          data: [
            {
              b64_json: payload.b64_json,
              url: payload.url,
            },
          ],
          error: payload.error,
        };
      },
      onError: (error) => {
        throw new ImageStreamError(
          `Image generation stream could not be parsed: ${error.message}`,
          true,
        );
      },
      maxBufferSize: 128 * 1024 * 1024,
    });

    stream.setEncoding('utf8');
    try {
      for await (const chunk of stream) {
        parser.feed(String(chunk));
        if (completedResponse) {
          stream.destroy();
          return await this.extractImageBuffer(completedResponse, connection);
        }
      }
      parser.reset({ consume: true });
      if (completedResponse) {
        return await this.extractImageBuffer(completedResponse, connection);
      }
    } finally {
      stream.destroy();
    }

    throw new ImageStreamError(
      'Image generation stream ended without a completed event',
      true,
    );
  }

  private decodeBase64Image(value: string): Buffer | undefined {
    const normalized = value.replace(/\s/g, '');
    if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
      return undefined;
    }

    const unpadded = normalized.replace(/=+$/, '');
    if (!unpadded || unpadded.length % 4 === 1) {
      return undefined;
    }
    if (normalized.includes('=') && normalized.length % 4 !== 0) {
      return undefined;
    }

    const imageBuffer = Buffer.from(normalized, 'base64');
    const canonicalBase64 = imageBuffer.toString('base64').replace(/=+$/, '');
    if (canonicalBase64 !== unpadded) {
      return undefined;
    }

    return imageBuffer;
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
    if (error instanceof ImageStreamError) {
      return error.retryable;
    }

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

  private async generationErrorMessage(error: unknown): Promise<string> {
    if (axios.isAxiosError<OpenAIImageResponse | Readable>(error)) {
      const responseData = error.response?.data;
      if (responseData instanceof Readable) {
        try {
          const parsed = await this.readJsonStream(responseData);
          if (parsed.error?.message) return parsed.error.message;
        } catch {
          // Fall through to Axios' transport message when the error body is unreadable.
        }
      } else if (responseData?.error?.message) {
        return responseData.error.message;
      }

      return error.message || 'Image generation failed';
    }
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error) return error;
    return 'Image generation failed';
  }
}
