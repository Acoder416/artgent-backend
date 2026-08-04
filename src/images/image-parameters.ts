export const IMAGE_ASPECT_RATIOS = [
  '1:1',
  '4:5',
  '3:4',
  '2:3',
  '5:4',
  '4:3',
  '3:2',
  '16:9',
  '9:16',
] as const;
export const IMAGE_RESOLUTIONS = ['1K', '2K', '4K'] as const;
export const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high'] as const;

export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];
export type ImageResolution = (typeof IMAGE_RESOLUTIONS)[number];
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];

export const DEFAULT_IMAGE_ASPECT_RATIO: ImageAspectRatio = '1:1';
export const DEFAULT_IMAGE_RESOLUTION: ImageResolution = '1K';
export const DEFAULT_IMAGE_QUALITY: ImageQuality = 'auto';
export const MAX_IMAGE_PIXEL_COUNT = 3840 * 2160;

const IMAGE_SIZE_MAP: Record<
  ImageResolution,
  Record<ImageAspectRatio, string>
> = {
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
};

export function resolveImageSize(
  resolution: ImageResolution,
  aspectRatio: ImageAspectRatio,
): string {
  return IMAGE_SIZE_MAP[resolution][aspectRatio];
}
