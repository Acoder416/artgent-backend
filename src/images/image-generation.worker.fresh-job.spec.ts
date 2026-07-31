import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { UsersService } from '../users/users.service';
import { MinioService, type StoredImage } from '../upload/minio.service';
import { AiService } from './ai.service';
import { ImageGenerationWorker } from './image-generation.worker';
import { Image } from './image.entity';

describe('ImageGenerationWorker fresh job recovery check', () => {
  it('does not query legacy MinIO keys for a job without a persisted output key', async () => {
    const statImage = jest
      .fn()
      .mockRejectedValue(
        new Error('Valid and authorized credentials required'),
      );
    const worker = new ImageGenerationWorker(
      {} as Repository<Image>,
      {} as AiService,
      { statImage } as unknown as MinioService,
      {} as UsersService,
      new ConfigService(),
    );
    const workerWithRecovery = worker as unknown as {
      findStoredOutput(image: Image): Promise<StoredImage | null>;
    };
    const image = new Image();
    image.id = 154;
    image.userId = 1;
    image.imageKey = null;

    await expect(
      workerWithRecovery.findStoredOutput(image),
    ).resolves.toBeNull();
    expect(statImage).not.toHaveBeenCalled();
  });
});
