import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { UsersService } from '../users/users.service';
import { MinioService } from '../upload/minio.service';
import { AiService } from './ai.service';
import { Image } from './image.entity';
import { ImagesService } from './images.service';

describe('ImagesService downloads', () => {
  const image = Object.assign(new Image(), {
    id: 42,
    userId: 7,
    imageUrl: 'https://static.example.com/images/7/result.png',
  });
  const repository = {
    findOne: jest.fn().mockResolvedValue(image),
  } as unknown as Repository<Image>;
  const openImageByUrl = jest.fn().mockResolvedValue({
    stream: {},
    key: 'images/7/result.png',
    size: 128,
    contentType: 'image/png',
  });
  const service = new ImagesService(
    repository,
    {} as UsersService,
    {} as AiService,
    { openImageByUrl } as unknown as MinioService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('returns an attachment payload for the image owner', async () => {
    await expect(service.getDownload(42, 7)).resolves.toMatchObject({
      filename: 'cadriva-42.png',
      size: 128,
      contentType: 'image/png',
    });
    expect(openImageByUrl).toHaveBeenCalledWith(image.imageUrl);
  });

  it('does not expose another user image', async () => {
    await expect(service.getDownload(42, 8)).rejects.toBeInstanceOf(NotFoundException);
    expect(openImageByUrl).not.toHaveBeenCalled();
  });
});