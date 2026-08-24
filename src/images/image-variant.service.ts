import { Inject, Injectable, Optional } from '@nestjs/common';
import sharp from 'sharp';

export interface ImageVariantBuffers {
  thumbnail: Buffer;
  preview: Buffer;
}

export type ImageVariantProcessor = (
  source: Buffer,
) => Promise<ImageVariantBuffers>;

export const IMAGE_VARIANT_PROCESSOR = Symbol('IMAGE_VARIANT_PROCESSOR');

@Injectable()
export class ImageVariantService {
  private readonly waiting: Array<() => void> = [];
  private activeJobs = 0;

  constructor(
    @Optional()
    @Inject(IMAGE_VARIANT_PROCESSOR)
    private readonly processor: ImageVariantProcessor = generateWithSharp,
  ) {}

  async generate(source: Buffer): Promise<ImageVariantBuffers> {
    await this.acquire();
    try {
      return await this.processor(source);
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.activeJobs < 2) {
      this.activeJobs += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.activeJobs += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.activeJobs -= 1;
    this.waiting.shift()?.();
  }
}

async function generateWithSharp(source: Buffer): Promise<ImageVariantBuffers> {
  const pipeline = sharp(source, { failOn: 'error' }).rotate();
  const [thumbnail, preview] = await Promise.all([
    pipeline
      .clone()
      .resize({
        width: 640,
        height: 960,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 78 })
      .toBuffer(),
    pipeline
      .clone()
      .resize({
        width: 1_600,
        height: 1_600,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 82 })
      .toBuffer(),
  ]);

  return { thumbnail, preview };
}
