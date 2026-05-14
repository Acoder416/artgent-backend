import { Injectable, Logger } from '@nestjs/common';
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

  constructor(private configService: ConfigService) {
    this.baseUrl = this.configService.get(
      'SUB2API_BASE_URL',
      'http://127.0.0.1:9099',
    );
    this.apiKey = this.configService.get('SUB2API_KEY', '');
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

      const response = referenceCount > 0
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
