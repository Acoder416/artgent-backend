import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { MinioService } from '../upload/minio.service';
import { AiService } from './ai.service';
import { Image } from './image.entity';
import { ImagesService } from './images.service';

describe('ImagesService batch generation', () => {
  it('creates up to five isolated results and charges one credit per image', async () => {
    const user = Object.assign(new User(), {
      id: 3,
      credits: 10,
      totalCreditsEarned: 10,
      totalCreditsSpent: 0,
      role: 'user',
    });
    const userRepository = {
      findOne: () => Promise.resolve(user),
      save: (candidate: User) => Promise.resolve(candidate),
    } as unknown as Repository<User>;
    const rows: Image[] = [];
    const imageRepository = {
      create: (input: Partial<Image>) => Object.assign(new Image(), input),
      save: (image: Image) => {
        if (!image.id) {
          image.id = rows.length + 1;
          rows.push(image);
        }
        return Promise.resolve(image);
      },
      findOne: ({ where }: { where: Partial<Image> }) =>
        Promise.resolve(rows.find((item) => item.id === where.id) || null),
    } as unknown as Repository<Image>;
    const ai = {
      generateImage: () => new Promise(() => undefined),
    } as unknown as AiService;
    const service = new ImagesService(
      imageRepository,
      new UsersService(userRepository),
      ai,
      new MinioService(new ConfigService()),
    );

    const result = await service.generateBatch(3, {
      prompt: 'A precise editorial product photograph',
      model: 'gpt-image-2',
      aspectRatio: '4:5',
      resolution: '2K',
      quantity: 3,
      template: 'ecommerce',
    });

    expect(result.images).toHaveLength(3);
    expect(new Set(result.images.map((item) => item.requestId)).size).toBe(1);
    expect(result.images[0]).toMatchObject({
      status: 'generating',
      width: 1638,
      height: 2048,
      aspectRatio: '4:5',
      resolution: '2K',
      template: 'ecommerce',
    });
    expect(user.credits).toBe(7);
    expect(user.totalCreditsSpent).toBe(3);
  });
});
