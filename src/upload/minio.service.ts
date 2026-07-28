import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';
import { randomUUID } from 'crypto';

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

  /**
   * 上传图片Buffer到MinIO
   * @param imageBuffer 图片数据
   * @param userId 用户ID
   * @param ext 文件扩展名 (png/jpg)
   * @returns 公开访问URL
   */
  async uploadImage(
    imageBuffer: Buffer,
    userId: number,
    ext: string = 'png',
  ): Promise<string> {
    const key = `images/${userId}/${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;

    await this.minioClient.putObject(
      this.bucket,
      key,
      imageBuffer,
      imageBuffer.length,
      {
        'Content-Type':
          ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`,
      },
    );

    const url = `${this.publicUrl}/${key}`;
    this.logger.log(`Image uploaded: ${key}`);
    return url;
  }

  async openImageByUrl(imageUrl: string) {
    const key = this.getImageKey(imageUrl);
    if (!key) throw new Error('Unsupported image URL');

    const stat = await this.minioClient.statObject(this.bucket, key);
    const stream = await this.minioClient.getObject(this.bucket, key);
    const contentType = stat.metaData?.['content-type'] || this.contentTypeForKey(key);
    return { stream, key, size: stat.size, contentType };
  }

  async deleteImageByUrl(imageUrl: string): Promise<void> {
    const key = this.getImageKey(imageUrl);
    if (!key) return;

    try {
      await this.deleteImage(key);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Unable to delete image ${key}: ${message}`);
    }
  }

  /**
   * 删除MinIO上的图片
   * @param key 文件key
   */
  async deleteImage(key: string): Promise<void> {
    await this.minioClient.removeObject(this.bucket, key);
    this.logger.log(`Image deleted: ${key}`);
  }

  private getImageKey(imageUrl: string): string | null {
    const publicUrl = this.publicUrl.replace(/\/+$/, '');
    const prefix = publicUrl ? `${publicUrl}/` : '/';
    if (!imageUrl.startsWith(prefix)) return null;
    const key = imageUrl.slice(prefix.length);
    return key.startsWith('images/') ? key : null;
  }

  private contentTypeForKey(key: string): string {
    if (/\.jpe?g$/i.test(key)) return 'image/jpeg';
    if (/\.webp$/i.test(key)) return 'image/webp';
    if (/\.gif$/i.test(key)) return 'image/gif';
    return 'image/png';
  }
}
