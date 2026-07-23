import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { MinioService } from '../upload/minio.service';
import { AiService } from './ai.service';
import { Image } from './image.entity';
import { ImagesService } from './images.service';

function createUserRepository(user: User): Repository<User> {
  return {
    findOne: ({ where }: { where: Partial<User> }) =>
      Promise.resolve(
        Object.entries(where).every(
          ([key, value]) => user[key as keyof User] === value,
        )
          ? user
          : null,
      ),
    save: (candidate: User) => Promise.resolve(candidate),
  } as unknown as Repository<User>;
}

function createImageRepository(): Repository<Image> {
  const images: Image[] = [];

  return {
    create: (input: Partial<Image>) => Object.assign(new Image(), input),
    save: (image: Image) => {
      if (!image.id) {
        image.id = images.length + 1;
        images.push(image);
      }
      return Promise.resolve(image);
    },
    findOne: ({ where }: { where: Partial<Image> }) =>
      Promise.resolve(
        images.find((image) =>
          Object.entries(where).every(
            ([key, value]) => image[key as keyof Image] === value,
          ),
        ) ?? null,
      ),
  } as unknown as Repository<Image>;
}

describe('ImagesService administrator credits', () => {
  it('allows an administrator with zero credits to generate without deduction', async () => {
    const administrator = Object.assign(new User(), {
      id: 1,
      username: 'admin',
      email: 'admin@artgen.local',
      passwordHash: 'unused',
      credits: 0,
      role: 'admin',
    });
    const config = new ConfigService({ SUB2API_KEY: '' });
    const usersService = new UsersService(createUserRepository(administrator));
    const service = new ImagesService(
      createImageRepository(),
      usersService,
      new AiService(config),
      new MinioService(config),
    );

    const image = await service.generate(1, 'Create an abstract landscape');
    const profile = await usersService.getProfile(1);

    expect(image.status).toBe('generating');
    expect(profile.credits).toBe(0);
  });
});
