import sharp from 'sharp';
import { ImageVariantService } from './image-variant.service';

describe('ImageVariantService', () => {
  it('creates bounded WebP variants from a portrait image', async () => {
    const source = await sharp({
      create: {
        width: 1_200,
        height: 2_400,
        channels: 4,
        background: { r: 45, g: 120, b: 210, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();

    const variants = await new ImageVariantService().generate(source);

    await expect(sharp(variants.thumbnail).metadata()).resolves.toMatchObject({
      width: 480,
      height: 960,
      format: 'webp',
      hasAlpha: true,
    });
    await expect(sharp(variants.preview).metadata()).resolves.toMatchObject({
      width: 800,
      height: 1_600,
      format: 'webp',
      hasAlpha: true,
    });
  });

  it('preserves a landscape aspect ratio within each boundary', async () => {
    const source = await sharp({
      create: {
        width: 2_400,
        height: 1_200,
        channels: 3,
        background: { r: 90, g: 140, b: 30 },
      },
    })
      .png()
      .toBuffer();

    const variants = await new ImageVariantService().generate(source);

    await expect(sharp(variants.thumbnail).metadata()).resolves.toMatchObject({
      width: 640,
      height: 320,
    });
    await expect(sharp(variants.preview).metadata()).resolves.toMatchObject({
      width: 1_600,
      height: 800,
    });
  });

  it('does not enlarge a source that already fits both boundaries', async () => {
    const source = await sharp({
      create: {
        width: 320,
        height: 180,
        channels: 3,
        background: { r: 20, g: 30, b: 40 },
      },
    })
      .png()
      .toBuffer();

    const variants = await new ImageVariantService().generate(source);

    await expect(sharp(variants.thumbnail).metadata()).resolves.toMatchObject({
      width: 320,
      height: 180,
    });
    await expect(sharp(variants.preview).metadata()).resolves.toMatchObject({
      width: 320,
      height: 180,
    });
  });

  it('applies EXIF orientation and removes it from the variants', async () => {
    const source = await sharp({
      create: {
        width: 80,
        height: 40,
        channels: 3,
        background: { r: 200, g: 40, b: 90 },
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const variants = await new ImageVariantService().generate(source);
    const metadata = await sharp(variants.thumbnail).metadata();

    expect(metadata).toMatchObject({ width: 40, height: 80, format: 'webp' });
    expect(metadata.orientation).toBeUndefined();
  });

  it('rejects corrupted input', async () => {
    await expect(
      new ImageVariantService().generate(Buffer.from('not an image')),
    ).rejects.toThrow();
  });

  it('runs at most two variant jobs concurrently', async () => {
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    const releases: Array<() => void> = [];
    const processor = jest.fn(async (source: Buffer) => {
      started += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return { thumbnail: source, preview: source };
    });
    const service = new ImageVariantService(processor);

    const jobs = [1, 2, 3].map((value) =>
      service.generate(Buffer.from([value])),
    );
    await waitUntil(() => started === 2);

    expect(maximumActive).toBe(2);
    expect(processor).toHaveBeenCalledTimes(2);

    releases.shift()?.();
    await waitUntil(() => started === 3);
    releases.splice(0).forEach((release) => release());
    await Promise.all(jobs);

    expect(maximumActive).toBe(2);
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Condition was not reached');
}
