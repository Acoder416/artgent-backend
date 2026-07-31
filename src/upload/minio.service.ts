import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import * as Minio from 'minio';
import {
  detectImageMetadata,
  ImageFormat,
  ImageMetadata,
  ImageMimeType,
} from './image-format';

export interface StoreImageOptions {
  key?: string;
  folder?: string;
}

export interface StoredImage {
  key: string;
  url: string;
  mimeType: ImageMimeType;
  imageFormat: ImageFormat;
}

export interface StoredImageObject extends StoredImage {
  size: number;
}

export interface OpenedStoredImage extends StoredImageObject {
  stream: Readable;
  contentType: ImageMimeType;
}

export interface ReadStoredImage extends StoredImageObject {
  buffer: Buffer;
}

@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  private minioClient: Minio.Client;
  private bucket: string;
  private publicUrl: string;

  constructor(private configService: ConfigService) {
    this.bucket = this.configService.get('MINIO_BUCKET', 'artgen');
    this.publicUrl = this.configService.get('MINIO_PUBLIC_URL', '');
  }

  onModuleInit() {
    this.minioClient = new Minio.Client({
      endPoint: this.configService.get('MINIO_ENDPOINT', 'localhost'),
      port: parseInt(this.configService.get('MINIO_PORT', '9000')),
      useSSL: this.configService.get('MINIO_USE_SSL') === 'true',
      accessKey: this.configService.get('MINIO_ACCESS_KEY', ''),
      secretKey: this.configService.get('MINIO_SECRET_KEY', ''),
    });
    this.logger.log('MinIO client initialized');
  }

  async storeImage(
    imageBuffer: Buffer,
    userId: number,
    options: StoreImageOptions = {},
  ): Promise<StoredImage> {
    const metadata = detectImageMetadata(imageBuffer);
    if (!metadata) throw new Error('Unsupported image format');

    const key = options.key
      ? this.validateObjectKey(options.key)
      : this.createObjectKey(userId, options.folder || 'images', metadata);

    await this.minioClient.putObject(
      this.bucket,
      key,
      imageBuffer,
      imageBuffer.length,
      { 'Content-Type': metadata.mimeType },
    );

    this.logger.log(`Image uploaded: ${key}`);
    return {
      key,
      url: this.urlForKey(key),
      ...metadata,
    };
  }

  async uploadImage(
    imageBuffer: Buffer,
    userId: number,
    ext: string = 'png',
  ): Promise<string> {
    void ext;
    return (await this.storeImage(imageBuffer, userId)).url;
  }

  async readImage(key: string): Promise<Buffer> {
    const stream = await this.minioClient.getObject(
      this.bucket,
      this.validateObjectKey(key),
    );
    return this.readStream(stream);
  }

  async readImageByUrl(imageUrl: string): Promise<ReadStoredImage> {
    const opened = await this.openImageByUrl(imageUrl);
    return {
      key: opened.key,
      url: opened.url,
      size: opened.size,
      mimeType: opened.mimeType,
      imageFormat: opened.imageFormat,
      buffer: await this.readStream(opened.stream),
    };
  }

  async statImage(key: string): Promise<StoredImageObject | null> {
    const safeKey = this.validateObjectKey(key);
    try {
      const stat = await this.minioClient.statObject(this.bucket, safeKey);
      const metadata = this.metadataForStoredObject(safeKey, stat.metaData);
      if (!metadata) {
        throw new Error(`Unsupported stored image format: ${safeKey}`);
      }
      return {
        key: safeKey,
        url: this.urlForKey(safeKey),
        size: stat.size,
        ...metadata,
      };
    } catch (error: unknown) {
      if (this.isMissingObject(error)) return null;
      throw error;
    }
  }

  async openImageByKey(key: string): Promise<OpenedStoredImage> {
    const stored = await this.statImage(key);
    if (!stored) throw new Error('Image not found');

    const stream = await this.minioClient.getObject(this.bucket, stored.key);
    return {
      ...stored,
      stream,
      contentType: stored.mimeType,
    };
  }

  async openImageByUrl(imageUrl: string): Promise<OpenedStoredImage> {
    const key = this.getImageKey(imageUrl);
    if (!key) throw new Error('Unsupported image URL');
    return this.openImageByKey(key);
  }

  async deleteImageByUrl(imageUrl: string): Promise<void> {
    try {
      await this.deleteImageByUrlStrict(imageUrl);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Unable to delete image by URL: ${message}`);
    }
  }

  async deleteImageByUrlStrict(imageUrl: string): Promise<void> {
    const key = this.getImageKey(imageUrl);
    if (!key) throw new Error('Unsupported image URL');
    await this.deleteImage(key);
  }

  async deleteImage(key: string): Promise<void> {
    const safeKey = this.validateObjectKey(key);
    await this.minioClient.removeObject(this.bucket, safeKey);
    this.logger.log(`Image deleted: ${safeKey}`);
  }

  private async readStream(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private createObjectKey(
    userId: number,
    folder: string,
    metadata: ImageMetadata,
  ): string {
    const safeFolder = this.validateObjectKey(`${folder}/placeholder`).slice(
      0,
      -'/placeholder'.length,
    );
    const extension =
      metadata.imageFormat === 'jpeg' ? 'jpg' : metadata.imageFormat;
    return `${safeFolder}/${userId}/${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
  }

  private validateObjectKey(key: string): string {
    const segments = key.split('/');
    if (
      !key ||
      key.startsWith('/') ||
      key.endsWith('/') ||
      key.includes('\\') ||
      segments.some(
        (segment) => !segment || segment === '.' || segment === '..',
      )
    ) {
      throw new Error('Invalid image object key');
    }
    return key;
  }

  private urlForKey(key: string): string {
    const publicUrl = this.publicUrl.replace(/\/+$/, '');
    return publicUrl ? `${publicUrl}/${key}` : `/${key}`;
  }

  private getImageKey(imageUrl: string): string | null {
    const publicUrl = this.publicUrl.replace(/\/+$/, '');
    const prefix = publicUrl ? `${publicUrl}/` : '/';
    if (!imageUrl.startsWith(prefix)) return null;
    const key = imageUrl.slice(prefix.length);
    return key.startsWith('images/') ? key : null;
  }

  private metadataForStoredObject(
    key: string,
    objectMetadata?: Record<string, unknown>,
  ): ImageMetadata | null {
    const contentTypeEntry = Object.entries(objectMetadata || {}).find(
      ([name]) => name.toLowerCase() === 'content-type',
    );
    const contentType = contentTypeEntry
      ? String(contentTypeEntry[1]).split(';', 1)[0].trim().toLowerCase()
      : '';

    if (contentType === 'image/png') {
      return { mimeType: 'image/png', imageFormat: 'png' };
    }
    if (contentType === 'image/jpeg') {
      return { mimeType: 'image/jpeg', imageFormat: 'jpeg' };
    }
    if (contentType === 'image/webp') {
      return { mimeType: 'image/webp', imageFormat: 'webp' };
    }
    if (/\.png$/i.test(key)) {
      return { mimeType: 'image/png', imageFormat: 'png' };
    }
    if (/\.jpe?g$/i.test(key)) {
      return { mimeType: 'image/jpeg', imageFormat: 'jpeg' };
    }
    if (/\.webp$/i.test(key)) {
      return { mimeType: 'image/webp', imageFormat: 'webp' };
    }
    return null;
  }

  private isMissingObject(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as {
      code?: string;
      statusCode?: number;
      response?: { statusCode?: number };
    };
    return (
      ['NoSuchKey', 'NoSuchObject', 'NotFound'].includes(
        candidate.code || '',
      ) ||
      candidate.statusCode === 404 ||
      candidate.response?.statusCode === 404
    );
  }
}
