import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  FindManyOptions,
  FindOperator,
  FindOptionsWhere,
  Repository,
} from 'typeorm';
import { UsersService } from '../users/users.service';
import { MinioService } from '../upload/minio.service';
import { AiService } from './ai.service';
import { Image } from './image.entity';
import { ImagesService } from './images.service';

const LATER = '2026-08-24T09:00:00.000Z';
const BOUNDARY = '2026-08-24T08:00:00.000Z';
const EARLIER = '2026-08-24T07:00:00.000Z';

function image(
  id: number,
  userId: number,
  createdAt: string,
  overrides: Partial<Image> = {},
): Image {
  return Object.assign(new Image(), {
    id,
    userId,
    requestId: null,
    prompt: `Prompt ${id}`,
    template: 'custom',
    status: 'completed',
    createdAt: new Date(createdAt),
    ...overrides,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rawPatternMatches(actual: unknown, pattern: string): boolean {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '=' && index + 1 < pattern.length) {
      expression += escapeRegExp(pattern[++index]);
    } else if (character === '%') {
      expression += '.*';
    } else if (character === '_') {
      expression += '.';
    } else {
      expression += escapeRegExp(character);
    }
  }
  return new RegExp(`^${expression}$`, 'i').test(String(actual));
}

function mysqlTimestamp(value: Date): string {
  const iso = value.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}000`;
}

function valueMatches(actual: unknown, expected: unknown): boolean {
  if (!(expected instanceof FindOperator)) {
    if (actual instanceof Date && expected instanceof Date) {
      return actual.getTime() === expected.getTime();
    }
    return actual === expected;
  }

  switch (expected.type) {
    case 'equal':
      return valueMatches(actual, expected.value);
    case 'lessThan':
      return (
        new Date(String(actual)).getTime() <
        new Date(String(expected.value)).getTime()
      );
    case 'moreThanOrEqual':
      return (
        new Date(String(actual)).getTime() >=
        new Date(String(expected.value)).getTime()
      );
    case 'and':
      return (expected.value as FindOperator<unknown>[]).every((operator) =>
        valueMatches(actual, operator),
      );
    case 'raw': {
      const parameters = (expected.objectLiteralParameters ?? {}) as Record<
        string,
        unknown
      >;
      const cursorTimestamp = parameters.imageCursorCreatedAt;
      if (typeof cursorTimestamp === 'string') {
        const actualTimestamp = mysqlTimestamp(new Date(actual as Date));
        const expression = expected.getSql?.('created_at') || '';
        return expression.includes(' < ')
          ? actualTimestamp < cursorTimestamp
          : actualTimestamp === cursorTimestamp;
      }
      const pattern: unknown = Object.values(parameters)[0];
      return typeof pattern === 'string' && rawPatternMatches(actual, pattern);
    }
    default:
      throw new Error(`Unsupported test operator: ${expected.type}`);
  }
}

function rowMatches(row: Image, where: FindOptionsWhere<Image>): boolean {
  return Object.entries(where).every(([field, expected]) =>
    valueMatches(row[field as keyof Image], expected),
  );
}

function createImageRepository(
  initialRows: Image[],
  cursorTimestamps: ReadonlyMap<number, string> = new Map(),
): Repository<Image> {
  const rows = [...initialRows];
  const matches = (
    row: Image,
    where?: FindOptionsWhere<Image> | FindOptionsWhere<Image>[],
  ) => {
    if (!where) return true;
    const alternatives = Array.isArray(where) ? where : [where];
    return alternatives.some((candidate) => rowMatches(row, candidate));
  };

  return {
    find: (options: FindManyOptions<Image> = {}) => {
      const ordered = rows
        .filter((row) => matches(row, options.where))
        .sort((left, right) => {
          for (const [field, direction] of Object.entries(
            options.order ?? {},
          )) {
            const a = left[field as keyof Image];
            const b = right[field as keyof Image];
            const aValue = a instanceof Date ? a.getTime() : Number(a);
            const bValue = b instanceof Date ? b.getTime() : Number(b);
            if (aValue === bValue) continue;
            const sign = aValue < bValue ? -1 : 1;
            return direction === 'DESC' ? -sign : sign;
          }
          return 0;
        });
      const start = options.skip ?? 0;
      const end = options.take === undefined ? undefined : start + options.take;
      return Promise.resolve(ordered.slice(start, end));
    },
    count: ({ where }: FindManyOptions<Image> = {}) =>
      Promise.resolve(rows.filter((row) => matches(row, where)).length),
    findOne: ({ where }: { where: FindOptionsWhere<Image> }) =>
      Promise.resolve(rows.find((row) => matches(row, where)) ?? null),
    query: (_query: string, parameters: [number, number]) => {
      const [id, userId] = parameters;
      const row = rows.find(
        (candidate) => candidate.id === id && candidate.userId === userId,
      );
      return Promise.resolve(
        row
          ? [
              {
                created_at_cursor:
                  cursorTimestamps.get(row.id) || mysqlTimestamp(row.createdAt),
              },
            ]
          : [],
      );
    },
  } as unknown as Repository<Image>;
}

function createService(
  rows: Image[],
  cursorTimestamps?: ReadonlyMap<number, string>,
): ImagesService {
  return new ImagesService(
    createImageRepository(rows, cursorTimestamps),
    {} as UsersService,
    {} as AiService,
    {} as MinioService,
  );
}

describe('ImagesService library queries', () => {
  it('uses createdAt and id as a stable descending cursor', async () => {
    const service = createService([
      image(5, 7, LATER),
      image(4, 7, BOUNDARY),
      image(3, 7, BOUNDARY),
      image(2, 7, BOUNDARY, { status: 'failed' }),
      image(1, 7, EARLIER),
      image(99, 8, LATER, { status: 'failed' }),
    ]);

    const first = await service.findByUserId(7, { limit: '2' });
    const second = await service.findByUserId(7, {
      limit: '2',
      cursor: first.nextCursor!,
    });

    expect({
      firstIds: first.images.map(({ id }) => id),
      secondIds: second.images.map(({ id }) => id),
      total: first.total,
      failedTotal: first.failedTotal,
      firstHasCursor: typeof first.nextCursor === 'string',
      secondHasCursor: typeof second.nextCursor === 'string',
    }).toEqual({
      firstIds: [5, 4],
      secondIds: [3, 2],
      total: 5,
      failedTotal: 1,
      firstHasCursor: true,
      secondHasCursor: true,
    });
  });

  it('preserves the database microseconds in an opaque cursor', async () => {
    const exactTimestamp = '2026-08-24 09:00:00.123456';
    const service = createService(
      [image(5, 7, LATER), image(4, 7, BOUNDARY)],
      new Map([[5, exactTimestamp]]),
    );

    const page = await service.findByUserId(7, { limit: '1' });
    const decoded = JSON.parse(
      Buffer.from(page.nextCursor!, 'base64url').toString('utf8'),
    );

    expect(decoded).toEqual([exactTimestamp, 5]);
  });

  it('filters the matching total while retaining the global failure total', async () => {
    const service = createService([
      image(1, 7, '2026-08-22T08:00:00.000Z', {
        prompt: 'A 50%_discount poster',
        template: 'poster',
      }),
      image(2, 7, '2026-08-23T08:00:00.000Z', {
        prompt: 'A 50 percent discount poster',
        template: 'poster',
      }),
      image(3, 7, '2026-08-24T08:00:00.000Z', {
        prompt: 'A 50%_discount portrait',
        template: 'portrait',
      }),
      image(4, 7, '2026-08-24T09:00:00.000Z', { status: 'failed' }),
    ]);

    const result = await service.findByUserId(7, {
      q: '50%_',
      template: 'poster',
      createdAfter: '2026-08-22T00:00:00.000Z',
    });

    expect({
      ids: result.images.map(({ id }) => id),
      total: result.total,
      failedTotal: result.failedTotal,
      nextCursor: result.nextCursor,
    }).toEqual({ ids: [1], total: 1, failedTotal: 1, nextCursor: null });
  });

  it('filters recent completed artwork for compact consumers', async () => {
    const service = createService([
      image(3, 7, LATER, { status: 'pending' }),
      image(2, 7, BOUNDARY, { status: 'completed' }),
      image(1, 7, EARLIER, { status: 'completed' }),
    ]);

    const result = await service.findByUserId(7, {
      limit: '9',
      status: 'completed',
    });

    expect(result.images.map(({ id }) => id)).toEqual([2, 1]);
    expect(result.total).toBe(2);
  });

  it('keeps explicit page requests in offset pagination mode', async () => {
    const service = createService([
      image(5, 7, LATER),
      image(4, 7, BOUNDARY),
      image(3, 7, BOUNDARY),
      image(2, 7, BOUNDARY),
      image(1, 7, EARLIER),
    ]);

    const result = await service.findByUserId(7, { page: '2', limit: '2' });

    expect(result.images.map(({ id }) => id)).toEqual([3, 2]);
    expect(result.total).toBe(5);
  });

  it.each([
    [{ page: '1', cursor: 'anything' }, 'page and cursor cannot be combined'],
    [{ cursor: 'not-a-valid-cursor' }, 'Invalid image cursor'],
    [{ createdAfter: 'not-a-date' }, 'Invalid createdAfter'],
    [{ status: 'unknown' }, 'Invalid image status'],
  ])('rejects invalid list query %#', async (query, message) => {
    const service = createService([]);

    await expect(service.findByUserId(7, query)).rejects.toEqual(
      new BadRequestException(message),
    );
  });
});

describe('ImagesService generation detail', () => {
  it('returns at most five results from the selected user-owned batch', async () => {
    const requestId = 'batch-1';
    const rows = Array.from({ length: 6 }, (_, index) =>
      image(index + 1, 7, `2026-08-24T08:00:0${index}.000Z`, { requestId }),
    );
    rows.push(image(20, 8, LATER, { requestId }));
    const service = createService(rows);

    const detail = await service.findDetailByUserId(3, 7);

    expect(detail.image.id).toBe(3);
    expect(detail.results.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns a request-less image as a one-item detail', async () => {
    const service = createService([image(3, 7, LATER)]);

    const detail = await service.findDetailByUserId(3, 7);

    expect(detail.results.map(({ id }) => id)).toEqual([3]);
  });

  it('does not expose an image owned by another user', async () => {
    const service = createService([image(3, 8, LATER)]);

    await expect(service.findDetailByUserId(3, 7)).rejects.toEqual(
      new NotFoundException('图片不存在'),
    );
  });
});
