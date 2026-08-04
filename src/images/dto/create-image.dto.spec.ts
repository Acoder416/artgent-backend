import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { CreateImageDto } from './create-image.dto';

const metadata: ArgumentMetadata = {
  type: 'body',
  metatype: CreateImageDto,
};

describe('CreateImageDto', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });

  it('accepts snake_case aliases and quality from multipart fields', async () => {
    const dto = (await pipe.transform(
      {
        prompt: 'A product photograph',
        aspect_ratio: '4:5',
        resolution: '2K',
        quality: 'high',
        n: '3',
      },
      metadata,
    )) as CreateImageDto;

    expect(dto).toMatchObject({
      aspect_ratio: '4:5',
      resolution: '2K',
      quality: 'high',
      n: 3,
    });
  });

  it.each([
    ['aspect_ratio', '7:5'],
    ['resolution', '8K'],
    ['quality', 'ultra'],
    ['n', '6'],
  ])('rejects an invalid %s value', async (field, value) => {
    await expect(
      pipe.transform(
        { prompt: 'A product photograph', [field]: value },
        metadata,
      ),
    ).rejects.toBeDefined();
  });
});
