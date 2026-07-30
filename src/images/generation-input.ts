export type ImageJobInputReference =
  | {
      kind: 'object';
      key: string;
      url: string;
      mimeType: string;
      originalName: string;
    }
  | {
      kind: 'url';
      url: string;
    };
