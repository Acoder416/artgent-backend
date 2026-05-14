export interface UploadedImageFile {
  buffer: Buffer;
  mimetype?: string;
  originalname?: string;
}

export interface ReferenceImage {
  file?: UploadedImageFile;
  files?: UploadedImageFile[];
  url?: string;
  urls?: string[];
}
