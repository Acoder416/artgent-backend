import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsersService } from '../users/users.service';
import { MinioService } from '../upload/minio.service';
import { AiService } from './ai.service';
import { Image } from './image.entity';
import { ImagesController } from './images.controller';
import { ImagesService } from './images.service';

function createImageRepository(initialRows: Image[]): Repository<Image> {
  const rows = [...initialRows];

  return {
    find: ({ where }: { where: Partial<Image> }) =>
      Promise.resolve(
        rows.filter(
          (image) =>
            image.userId === where.userId && image.status === where.status,
        ),
      ),
    delete: (criteria: Partial<Image> | number[]) => {
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (Array.isArray(criteria) && criteria.includes(rows[index].id)) {
          rows.splice(index, 1);
        }
      }
      return Promise.resolve({ raw: [], affected: before - rows.length });
    },
    findAndCount: ({ where }: { where: Partial<Image> }) => {
      const matches = rows.filter((image) => image.userId === where.userId);
      return Promise.resolve([matches, matches.length]);
    },
  } as unknown as Repository<Image>;
}

describe('DELETE /api/images/failed', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const image = (
      id: number,
      userId: number,
      status: Image['status'],
    ): Image =>
      Object.assign(new Image(), {
        id,
        userId,
        status,
        jobVersion: 1,
        refundedAt: status === 'failed' ? new Date() : null,
      });
    const unrefunded = image(5, 7, 'failed');
    unrefunded.refundedAt = null;
    const legacyFailure = image(6, 7, 'failed');
    legacyFailure.jobVersion = 0;
    legacyFailure.refundedAt = null;
    const service = new ImagesService(
      createImageRepository([
        image(1, 7, 'failed'),
        image(2, 7, 'completed'),
        image(3, 7, 'generating'),
        image(4, 8, 'failed'),
        unrefunded,
        legacyFailure,
      ]),
      {} as UsersService,
      {} as AiService,
      {} as MinioService,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [ImagesController],
      providers: [
        { provide: ImagesService, useValue: service },
        { provide: AiService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest<{
            headers: Record<string, string | string[] | undefined>;
            user?: { id: number };
          }>();
          const header = req.headers['x-user-id'];
          req.user = {
            id: Number(Array.isArray(header) ? header[0] : header),
          };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('deletes only failed images owned by the authenticated user', async () => {
    const deletion = await request(app.getHttpServer())
      .delete('/api/images/failed')
      .set('x-user-id', '7');
    const ownerLibrary = await request(app.getHttpServer())
      .get('/api/images')
      .set('x-user-id', '7');
    const otherLibrary = await request(app.getHttpServer())
      .get('/api/images')
      .set('x-user-id', '8');

    const deletionBody = deletion.body as { deletedCount: number };
    const ownerBody = ownerLibrary.body as { images: Image[] };
    const otherBody = otherLibrary.body as { images: Image[] };

    expect({
      deletion: { status: deletion.status, body: deletionBody },
      ownerImageIds: ownerBody.images.map((item) => item.id),
      otherImageIds: otherBody.images.map((item) => item.id),
    }).toEqual({
      deletion: {
        status: 200,
        body: { deletedCount: 2, deletedIds: [1, 6] },
      },
      ownerImageIds: [2, 3, 5],
      otherImageIds: [4],
    });
  });
});
