import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_RESOLUTIONS,
  resolveImageSize,
} from './image-parameters';

const EXPECTED_IMAGE_SIZES = {
  '1K': {
    '1:1': '1024x1024',
    '4:5': '768x960',
    '3:4': '768x1024',
    '2:3': '672x1008',
    '5:4': '960x768',
    '4:3': '1024x768',
    '3:2': '1008x672',
    '16:9': '1024x640',
    '9:16': '640x1024',
  },
  '2K': {
    '1:1': '2048x2048',
    '4:5': '1600x2000',
    '3:4': '1536x2048',
    '2:3': '1344x2016',
    '5:4': '2000x1600',
    '4:3': '2048x1536',
    '3:2': '2016x1344',
    '16:9': '2048x1152',
    '9:16': '1152x2048',
  },
  '4K': {
    '1:1': '2880x2880',
    '4:5': '2560x3200',
    '3:4': '2448x3264',
    '2:3': '2336x3504',
    '5:4': '3200x2560',
    '4:3': '3264x2448',
    '3:2': '3504x2336',
    '16:9': '3840x2160',
    '9:16': '2160x3840',
  },
} as const;

describe('image generation parameters', () => {
  it.each(
    IMAGE_RESOLUTIONS.flatMap((resolution) =>
      IMAGE_ASPECT_RATIOS.map(
        (aspectRatio) =>
          [
            resolution,
            aspectRatio,
            EXPECTED_IMAGE_SIZES[resolution][aspectRatio],
          ] as const,
      ),
    ),
  )('maps %s %s to provider size %s', (resolution, aspectRatio, expected) => {
    expect(resolveImageSize(resolution, aspectRatio)).toBe(expected);
  });

  it('does not use the over-limit 3840x3840 square size', () => {
    expect(resolveImageSize('4K', '1:1')).toBe('2880x2880');
  });
});
