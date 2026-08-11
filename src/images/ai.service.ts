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
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { isIPv4, isIPv6, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import {
  inspectDecodedImage,
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
      width: number;
      height: number;
      sha256: string;
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
const MAX_PROVIDER_RESPONSE_BYTES = 40 * 1024 * 1024;
const MAX_PROVIDER_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PROVIDER_IMAGE_BASE64_LENGTH =
  Math.ceil((MAX_PROVIDER_IMAGE_BYTES * 4) / 3) + 4;
const DEFAULT_IMAGE_STREAM_ENABLED = true;
const DEFAULT_PROMPT_REWRITE_MODEL = 'gpt-5.4-mini';
const DEFAULT_IMAGE_WORKER_CONCURRENCY = 10;
const MAX_GENERATED_IMAGE_REDIRECTS = 3;

interface GeneratedImageTarget {
  url: string;
  httpAgent?: HttpAgent;
  httpsAgent?: HttpsAgent;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [a, b, c] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%', 1)[0];
  const mappedIpv4 = normalized.match(/^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIpv4) return isPublicIpv4(mappedIpv4[1]);
  const firstGroup = Number.parseInt(normalized.split(':', 1)[0] || '0', 16);
  return (
    firstGroup >= 0x2000 &&
    firstGroup <= 0x3fff &&
    !normalized.startsWith('2001:db8:')
  );
}

function isPublicIpAddress(address: string): boolean {
  if (isIPv4(address)) return isPublicIpv4(address);
  if (isIPv6(address)) return isPublicIpv6(address);
  return false;
}

function parseStrictBoolean(value: unknown, key: string): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') {
    throw new Error(`${key} must be true or false`);
  }

  const normalized = value.trim().toLowerCase();
  const enabledValues = ['1', 'true', 'on', 'yes'];
  const disabledValues = ['0', 'false', 'off', 'no'];
  if (
    !enabledValues.includes(normalized) &&
    !disabledValues.includes(normalized)
  ) {
    throw new Error(`${key} must be true or false`);
  }
  return enabledValues.includes(normalized);
}

function parseNonEmptyString(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function parsePositiveInteger(value: unknown, key: string): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly connections: Map<AiLineId, AiLineConnection>;
  private readonly defaultLineId: AiLineId;

  constructor(private configService: ConfigService) {
    const defaultStreamEnabled = parseStrictBoolean(
      this.configService.get<string | boolean>(
        'IMAGE_STREAM_ENABLED',
        DEFAULT_IMAGE_STREAM_ENABLED,
      ),
      'IMAGE_STREAM_ENABLED',
    );
    const defaultPromptRewriteModel = parseNonEmptyString(
      this.configService.get<unknown>(
        'PROMPT_REWRITE_MODEL',
        DEFAULT_PROMPT_REWRITE_MODEL,
      ),
      'PROMPT_REWRITE_MODEL',
    );
    const defaultMaxConcurrency = parsePositiveInteger(
      this.configService.get<unknown>(
        'IMAGE_WORKER_CONCURRENCY',
        DEFAULT_IMAGE_WORKER_CONCURRENCY,
      ),
      'IMAGE_WORKER_CONCURRENCY',
    );
    const configuration = loadAiLinesConfiguration({
      projectDir: process.cwd(),
      configFile: this.configService.get<string>(
        'AI_LINES_CONFIG_FILE',
        'config/ai-lines.json',
      ),
      getEnvironmentValue: (key) => this.configService.get<string>(key),
      defaultLineOverride: this.configService.get<string>('AI_DEFAULT_LINE'),
      defaultStreamEnabled,
      defaultPromptRewriteModel,
      defaultMaxConcurrency,
    });
    this.defaultLineId = configuration.defaultLineId;
    this.connections = new Map(
      configuration.lines.map((connection) => [connection.id, connection]),
    );

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

  getLineMaxConcurrency(lineId?: AiLineId): number {
    return this.resolveConnection(lineId).maxConcurrency;
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
      if (referenceImage?.mask && referenceCount === 0) {
        throw new BadRequestException('A mask requires a reference image');
      }
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
          model: connection.promptRewriteModel,
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
        ...(connection.streamEnabled
          ? {
              stream: true,
              partial_images: IMAGE_PARTIAL_IMAGES,
            }
          : {
              ...(connection.responseFormat === undefined
                ? {}
                : { response_format: connection.responseFormat }),
              ...(connection.historyDisabled === undefined
                ? {}
                : { history_disabled: connection.historyDisabled }),
            }),
      },
      {
        headers: {
          Authorization: `Bearer ${connection.apiKey}`,
          'Content-Type': 'application/json',
          ...(connection.streamEnabled ? { Accept: 'text/event-stream' } : {}),
        },
        timeout: 1200000,
        maxContentLength: MAX_PROVIDER_RESPONSE_BYTES,
        ...(connection.streamEnabled
          ? { responseType: 'stream' as const }
          : {}),
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
    if (connection.streamEnabled) {
      formData.append('stream', 'true');
      formData.append('partial_images', String(IMAGE_PARTIAL_IMAGES));
    } else {
      if (connection.responseFormat !== undefined) {
        formData.append('response_format', connection.responseFormat);
      }
      if (connection.historyDisabled !== undefined) {
        formData.append('history_disabled', String(connection.historyDisabled));
      }
    }
    files.forEach((file, index) => {
      formData.append(
        'image',
        this.fileToBlob(file),
        file.originalname || `reference-${index + 1}.png`,
      );
    });
    if (referenceImage.mask) {
      formData.append(
        'mask',
        this.fileToBlob(referenceImage.mask),
        referenceImage.mask.originalname || 'mask.png',
      );
    }

    return axios.post<OpenAIImageResponse | Readable>(
      `${connection.baseUrl}/v1/images/edits`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${connection.apiKey}`,
          ...(connection.streamEnabled ? { Accept: 'text/event-stream' } : {}),
        },
        timeout: 1200000,
        maxContentLength: MAX_PROVIDER_RESPONSE_BYTES,
        ...(connection.streamEnabled
          ? { responseType: 'stream' as const }
          : {}),
      },
    );
  }

  private fileToBlob(file: UploadedImageFile): Blob {
    const imageBuffer = file.buffer;
    const imageBytes = new Uint8Array(
      imageBuffer.buffer as ArrayBuffer,
      imageBuffer.byteOffset,
      imageBuffer.byteLength,
    );

    return new Blob([imageBytes], {
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
      if (byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
        stream.destroy();
        throw new Error('Image generation API response exceeded 40 MB');
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
      maxBufferSize: MAX_PROVIDER_RESPONSE_BYTES,
    });

    stream.setEncoding('utf8');
    let streamedBytes = 0;
    try {
      for await (const chunk of stream) {
        const text = String(chunk);
        streamedBytes += Buffer.byteLength(text);
        if (streamedBytes > MAX_PROVIDER_RESPONSE_BYTES) {
          throw new ImageStreamError(
            'Image generation stream exceeded 40 MB',
            false,
          );
        }
        parser.feed(text);
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
    if (
      !normalized ||
      normalized.length > MAX_PROVIDER_IMAGE_BASE64_LENGTH ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
    ) {
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

  private async createGeneratedImageResult(
    imageBuffer: Buffer,
  ): Promise<GenerateImageResult> {
    const image = await inspectDecodedImage(imageBuffer);
    if (!image) {
      return {
        success: false,
        error: 'Image generation API returned an unsupported image format',
        retryable: false,
      };
    }

    return {
      success: true,
      imageBuffer,
      ...image,
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

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.downloadGeneratedImageOnce(imageUrl, connection);
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

  private async downloadGeneratedImageOnce(
    imageUrl: string,
    connection: AiLineConnection,
  ): Promise<AxiosResponse<ArrayBuffer>> {
    let currentUrl = imageUrl;
    for (
      let redirectCount = 0;
      redirectCount <= MAX_GENERATED_IMAGE_REDIRECTS;
      redirectCount += 1
    ) {
      const target = await this.resolveGeneratedImageTarget(
        currentUrl,
        connection,
      );
      const headers = this.isSameOrigin(target.url, connection.baseUrl)
        ? { Authorization: `Bearer ${connection.apiKey}` }
        : undefined;
      const response = await axios.get<ArrayBuffer>(target.url, {
        responseType: 'arraybuffer',
        headers,
        timeout: 120000,
        maxContentLength: MAX_PROVIDER_IMAGE_BYTES,
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
        ...(target.httpAgent ? { httpAgent: target.httpAgent } : {}),
        ...(target.httpsAgent ? { httpsAgent: target.httpsAgent } : {}),
      });
      const status = response.status ?? 200;
      if (![301, 302, 303, 307, 308].includes(status)) return response;
      const locationHeader: unknown = response.headers?.location;
      if (typeof locationHeader !== 'string' || !locationHeader) {
        throw new Error('Generated image redirect did not include a location');
      }
      if (redirectCount === MAX_GENERATED_IMAGE_REDIRECTS) {
        throw new Error('Generated image download exceeded redirect limit');
      }
      currentUrl = new URL(locationHeader, target.url).toString();
    }

    throw new Error('Generated image download exceeded redirect limit');
  }

  private async resolveGeneratedImageTarget(
    imageUrl: string,
    connection: AiLineConnection,
  ): Promise<GeneratedImageTarget> {
    let parsed: URL;
    try {
      parsed = new URL(imageUrl);
    } catch {
      throw new Error('Unsafe generated image URL');
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error('Unsafe generated image URL');
    }

    if (this.isSameOrigin(parsed.toString(), connection.baseUrl)) {
      return { url: parsed.toString() };
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local')
    ) {
      throw new Error('Unsafe generated image URL');
    }

    const literalFamily = isIPv4(hostname) ? 4 : isIPv6(hostname) ? 6 : 0;
    const addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await dnsLookup(hostname, { all: true, verbatim: true });
    if (
      addresses.length === 0 ||
      addresses.some((entry) => !isPublicIpAddress(entry.address))
    ) {
      throw new Error('Unsafe generated image URL');
    }

    const selected = addresses[0];
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [selected]);
      else callback(null, selected.address, selected.family);
    };
    return {
      url: parsed.toString(),
      ...(parsed.protocol === 'https:'
        ? { httpsAgent: new HttpsAgent({ lookup: pinnedLookup }) }
        : { httpAgent: new HttpAgent({ lookup: pinnedLookup }) }),
    };
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
