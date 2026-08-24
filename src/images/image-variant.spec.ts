import { imageVariantKeys } from './image-variant';

describe('imageVariantKeys', () => {
  it('derives deterministic WebP keys beside the original object', () => {
    expect(
      imageVariantKeys('images/7/42-11111111-1111-4111-8111-111111111111.png'),
    ).toEqual({
      thumbnail: 'images/7/42-11111111-1111-4111-8111-111111111111.thumb.webp',
      preview: 'images/7/42-11111111-1111-4111-8111-111111111111.preview.webp',
    });
  });
});
