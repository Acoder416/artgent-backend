export interface ImageVariantKeys {
  thumbnail: string;
  preview: string;
}

export function imageVariantKeys(imageKey: string): ImageVariantKeys {
  const extensionIndex = imageKey.lastIndexOf('.');
  if (extensionIndex <= imageKey.lastIndexOf('/')) {
    throw new Error('Original image key must include a file extension');
  }

  const baseKey = imageKey.slice(0, extensionIndex);
  return {
    thumbnail: `${baseKey}.thumb.webp`,
    preview: `${baseKey}.preview.webp`,
  };
}
