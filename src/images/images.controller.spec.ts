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

    await controller.generate({ user: { id: 7 } }, dto, []);

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

    expect(() => controller.generate({ user: { id: 7 } }, dto, [])).toThrow(
      new BadRequestException(message),
    );
    expect(generateBatch).not.toHaveBeenCalled();
  });
});

describe('ImagesController library queries', () => {
  const findByUserId = jest.fn();
  const findDetailByUserId = jest.fn();
  const controller = new ImagesController(
    { findByUserId, findDetailByUserId } as unknown as ImagesService,
    {} as AiService,
  );

  beforeEach(() => {
    findByUserId.mockReset();
    findDetailByUserId.mockReset();
  });

  it('forwards all list parameters as one user-scoped query', async () => {
    const response = {
      images: [],
      total: 0,
      failedTotal: 0,
      nextCursor: null,
    };
    findByUserId.mockResolvedValue(response);
    const query = {
      cursor: 'cursor-1',
      limit: '24',
      q: 'landscape',
      template: 'poster',
      createdAfter: '2026-08-01T00:00:00.000Z',
    };

    await expect(controller.findAll({ user: { id: 7 } }, query)).resolves.toBe(
      response,
    );
    expect(findByUserId).toHaveBeenCalledWith(7, query);
  });

  it('loads batch detail through the authenticated user scope', async () => {
    const response = { image: { id: 42 }, results: [{ id: 42 }] };
    findDetailByUserId.mockResolvedValue(response);

    await expect(controller.findDetail({ user: { id: 7 } }, 42)).resolves.toBe(
      response,
    );
    expect(findDetailByUserId).toHaveBeenCalledWith(42, 7);
  });
});
