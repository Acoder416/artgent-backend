import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { MinioService } from '../upload/minio.service';
import { AiService } from './ai.service';
import { Image } from './image.entity';
import { ImagesService } from './images.service';

describe('ImagesService image sizes', () => {
  it('rejects an explicit size whose edges are not multiples of 16', async () => {
    const administrator = Object.assign(new User(), {
      id: 1,
      credits: 0,
      role: 'admin',
    });
    const userRepository = {
      findOne: () => Promise.resolve(administrator),
      save: (candidate: User) => Promise.resolve(candidate),
    } as unknown as Repository<User>;
    const imageRepository = {
      create: (input: Partial<Image>) => Object.assign(new Image(), input),
      save: (image: Image) => Promise.resolve(image),
    } as unknown as Repository<Image>;
    const ai = {
      resolveLineId: () => 'line-a',
    } as unknown as AiService;
    const service = new ImagesService(
      imageRepository,
      new UsersService(userRepository),
      ai,
      {} as MinioService,
    );

    await expect(
      service.generateBatch(1, {
        prompt: 'A product photograph',
        size: '819x1024',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
