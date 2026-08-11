export type ImageJobInputReference =
  | {
      kind: 'object';
      role?: 'image' | 'mask';
      key: string;
      url: string;
      mimeType: string;
      originalName: string;
      size?: number;
    }
  | {
      kind: 'url';
      url: string;
    };
