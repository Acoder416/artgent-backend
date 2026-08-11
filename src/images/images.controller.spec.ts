import { BadRequestException } from '@nestjs/common';
import { AiService } from './ai.service';
import { CreateImageDto } from './dto/create-image.dto';
import { ImagesController } from './images.controller';
import { ImagesService } from './images.service';

describe('ImagesController generation parameters', () => {
  const generateBatch = jest.fn().mockResolvedValue({
    images: [],
    requestId: 'request-1',
    chargedCredits: 0,
  });
  const controller = new ImagesController(
    { generateBatch } as unknown as ImagesService,
    {} as AiService,
  );

  beforeEach(() => {
    generateBatch.mockClear();
  });

  it('normalizes snake_case aliases before enqueueing jobs', async () => {
    const dto = Object.assign(new CreateImageDto(), {
      prompt: 'A product photograph',
      aspect_ratio: '4:5' as const,
      resolution: '2K' as const,
      quality: 'high' as const,
      n: 3,
    });

    await controller.generate({ user: { id: 7 } }, dto, { images: [] });

    expect(generateBatch).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        aspectRatio: '4:5',
        resolution: '2K',
        quality: 'high',
        quantity: 3,
      }),
      { files: [], urls: [] },
    );
  });

  it('forwards an uploaded mask separately from reference images', async () => {
    const dto = Object.assign(new CreateImageDto(), {
      prompt: 'Replace only the masked area',
    });
    const image = {
      buffer: Buffer.from('image'),
      mimetype: 'image/png',
      originalname: 'reference.png',
    };
    const mask = {
      buffer: Buffer.from('mask'),
      mimetype: 'image/png',
      originalname: 'mask.png',
    };

    await controller.generate({ user: { id: 7 } }, dto, {
      images: [image],
      mask: [mask],
    });

    expect(generateBatch).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ prompt: dto.prompt }),
      { files: [image], urls: [], mask },
    );
  });

  it.each([
    [
      { aspectRatio: '1:1', aspect_ratio: '4:5' },
      'aspect ratio aliases must match',
    ],
    [{ quantity: 1, n: 2 }, 'quantity aliases must match'],
  ])('rejects conflicting aliases', (values, message) => {
    const dto = Object.assign(new CreateImageDto(), {
      prompt: 'A product photograph',
      ...values,
    });

    expect(() =>
      controller.generate({ user: { id: 7 } }, dto, { images: [] }),
    ).toThrow(new BadRequestException(message));
    expect(generateBatch).not.toHaveBeenCalled();
  });
});
