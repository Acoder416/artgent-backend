import { BadRequestException } from '@nestjs/common';
import { FindManyOptions, FindOperator, Repository } from 'typeorm';
import { UsersService } from '../users/users.service';
import { AiService } from './ai.service';
import { Image } from './image.entity';
import { ImagesController } from './images.controller';
import { ImagesService } from './images.service';
import { MinioService } from '../upload/minio.service';

describe('ImagesService batch statuses', () => {
  const ownedImages = [
    Object.assign(new Image(), { id: 3, userId: 7, status: 'pending' }),
    Object.assign(new Image(), { id: 1, userId: 7, status: 'completed' }),
  ];
  let lastFindOptions: FindManyOptions<Image> | undefined;
  const find = jest.fn((options: FindManyOptions<Image>) => {
    lastFindOptions = options;
    return Promise.resolve(ownedImages);
  });
  const service = new ImagesService(
    { find } as unknown as Repository<Image>,
    {} as UsersService,
    {} as AiService,
    {} as MinioService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    lastFindOptions = undefined;
  });

  function getLastFindOptions(): FindManyOptions<Image> {
    if (!lastFindOptions) throw new Error('Expected repository.find call');
    return lastFindOptions;
  }

  it('deduplicates IDs and filters the TypeORM query by owner', async () => {
    await expect(service.findStatusesByUserId(7, '3, 1,3')).resolves.toBe(
      ownedImages,
    );

    expect(find).toHaveBeenCalledTimes(1);
    const options = getLastFindOptions();
    const where = options.where;
    if (!where || Array.isArray(where)) throw new Error('Expected one where');
    expect(where.userId).toBe(7);
    if (!(where.id instanceof FindOperator)) {
      throw new Error('Expected an In operator');
    }
    expect(where.id.type).toBe('in');
    expect(where.id.value).toEqual([3, 1]);
  });

  it.each([
    undefined,
    '',
    '1,0',
    '1,-2',
    '1,2.5',
    '1,abc',
    '1,,2',
    ['1', '2'] as unknown as string,
  ])('rejects an invalid ids query: %p', async (ids) => {
    await expect(service.findStatusesByUserId(7, ids)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(find).not.toHaveBeenCalled();
  });

  it('rejects more than 100 requested IDs before deduplication', async () => {
    const ids = Array.from({ length: 101 }, () => '1').join(',');

    await expect(service.findStatusesByUserId(7, ids)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(find).not.toHaveBeenCalled();
  });

  it('accepts exactly 100 requested IDs', async () => {
    const ids = Array.from({ length: 100 }, (_, index) => index + 1).join(',');

    await expect(service.findStatusesByUserId(7, ids)).resolves.toBe(
      ownedImages,
    );
    const options = getLastFindOptions();
    const where = options.where;
    if (!where || Array.isArray(where)) throw new Error('Expected one where');
    if (!(where.id instanceof FindOperator)) {
      throw new Error('Expected an In operator');
    }
    expect(where.id.value).toHaveLength(100);
  });
});

describe('ImagesController batch statuses', () => {
  it('wraps the owned images for the polling response', async () => {
    const images = [Object.assign(new Image(), { id: 9, userId: 4 })];
    const findStatusesByUserId = jest.fn().mockResolvedValue(images);
    const controller = new ImagesController(
      { findStatusesByUserId } as unknown as ImagesService,
      {} as AiService,
    );

    await expect(
      controller.findStatuses({ user: { id: 4 } }, '9'),
    ).resolves.toEqual({ images });
    expect(findStatusesByUserId).toHaveBeenCalledWith(4, '9');
  });
});
