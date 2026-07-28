export const AI_LINE_ID_MAX_LENGTH = 64;
export const AI_LINE_ID_PATTERN = new RegExp(
  `^[a-z0-9][a-z0-9-]{0,${AI_LINE_ID_MAX_LENGTH - 1}}$`,
);
export type AiLineId = string;
