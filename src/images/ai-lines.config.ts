import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { AI_LINE_ID_PATTERN } from './ai-line';

interface AiLineFileEntry {
  id?: unknown;
  name?: unknown;
  baseUrl?: unknown;
  baseUrlEnv?: unknown;
  apiKeyEnv?: unknown;
  fallbackApiKeyEnv?: unknown;
  enabled?: unknown;
  streamEnabled?: unknown;
  promptRewriteModel?: unknown;
  maxConcurrency?: unknown;
  responseFormat?: unknown;
  historyDisabled?: unknown;
}

interface AiLinesFile {
  defaultLineId?: unknown;
  lines?: unknown;
}

export type AiLineResponseFormat = 'b64_json' | 'url';

export interface AiLineConnection {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  streamEnabled: boolean;
  promptRewriteModel: string;
  maxConcurrency: number;
  responseFormat?: AiLineResponseFormat;
  historyDisabled?: boolean;
}

export interface AiLinesConfiguration {
  defaultLineId: string;
  lines: AiLineConnection[];
}

interface LoadAiLinesOptions {
  projectDir: string;
  configFile: string;
  getEnvironmentValue: (key: string) => string | undefined;
  defaultLineOverride?: string;
  defaultStreamEnabled?: boolean;
  defaultPromptRewriteModel?: string;
  defaultMaxConcurrency?: number;
}

const DEFAULT_STREAM_ENABLED = true;
const DEFAULT_PROMPT_REWRITE_MODEL = 'gpt-5.4-mini';
const DEFAULT_MAX_CONCURRENCY = 10;

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`${field} must be true or false`);
  }
  return value;
}

function requireMaxConcurrency(
  value: unknown,
  field: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function requireResponseFormat(
  value: unknown,
  field: string,
): AiLineResponseFormat | undefined {
  if (value === undefined) return undefined;
  if (value !== 'b64_json' && value !== 'url') {
    throw new Error(`${field} must be b64_json or url`);
  }
  return value;
}

function normalizeBaseUrl(value: string, lineId: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`AI line "${lineId}" has an invalid base URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`AI line "${lineId}" must use HTTP or HTTPS`);
  }
  return value.replace(/\/+$/, '');
}

export function loadAiLinesConfiguration(
  options: LoadAiLinesOptions,
): AiLinesConfiguration {
  const configPath = isAbsolute(options.configFile)
    ? options.configFile
    : resolve(options.projectDir, options.configFile);
  let file: AiLinesFile;

  try {
    file = JSON.parse(readFileSync(configPath, 'utf8')) as AiLinesFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to load AI lines config at ${configPath}: ${message}`,
    );
  }

  if (!Array.isArray(file.lines) || file.lines.length === 0) {
    throw new Error('AI lines config must contain at least one line');
  }

  const ids = new Set<string>();
  const lines = (file.lines as AiLineFileEntry[])
    .filter((entry) => entry.enabled !== false)
    .map((entry, index): AiLineConnection => {
      const id = requireString(entry.id, `lines[${index}].id`);
      if (!AI_LINE_ID_PATTERN.test(id)) {
        throw new Error(`AI line id "${id}" has an invalid format`);
      }
      if (ids.has(id)) {
        throw new Error(`AI line id "${id}" is duplicated`);
      }
      ids.add(id);

      const name = requireString(entry.name, `lines[${index}].name`);
      const baseUrlEnv =
        typeof entry.baseUrlEnv === 'string' ? entry.baseUrlEnv.trim() : '';
      const configuredBaseUrl =
        (baseUrlEnv && options.getEnvironmentValue(baseUrlEnv)) ||
        (typeof entry.baseUrl === 'string' ? entry.baseUrl : '');
      if (!configuredBaseUrl) {
        throw new Error(
          `AI line "${id}" requires ${baseUrlEnv || 'a baseUrl'}`,
        );
      }

      const apiKeyEnv =
        typeof entry.apiKeyEnv === 'string' ? entry.apiKeyEnv.trim() : '';
      const fallbackApiKeyEnv =
        typeof entry.fallbackApiKeyEnv === 'string'
          ? entry.fallbackApiKeyEnv.trim()
          : '';
      const apiKey =
        (apiKeyEnv && options.getEnvironmentValue(apiKeyEnv)) ||
        (fallbackApiKeyEnv && options.getEnvironmentValue(fallbackApiKeyEnv)) ||
        '';

      const streamEnabled = requireBoolean(
        entry.streamEnabled,
        `lines[${index}].streamEnabled`,
        options.defaultStreamEnabled ?? DEFAULT_STREAM_ENABLED,
      );
      const promptRewriteModel =
        entry.promptRewriteModel === undefined
          ? options.defaultPromptRewriteModel || DEFAULT_PROMPT_REWRITE_MODEL
          : requireString(
              entry.promptRewriteModel,
              `lines[${index}].promptRewriteModel`,
            );
      const maxConcurrency = requireMaxConcurrency(
        entry.maxConcurrency,
        `lines[${index}].maxConcurrency`,
        options.defaultMaxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      );
      const responseFormat = requireResponseFormat(
        entry.responseFormat,
        `lines[${index}].responseFormat`,
      );
      const historyDisabled =
        entry.historyDisabled === undefined
          ? undefined
          : requireBoolean(
              entry.historyDisabled,
              `lines[${index}].historyDisabled`,
              false,
            );

      return {
        id,
        name,
        baseUrl: normalizeBaseUrl(configuredBaseUrl, id),
        apiKey,
        streamEnabled,
        promptRewriteModel,
        maxConcurrency,
        ...(responseFormat === undefined ? {} : { responseFormat }),
        ...(historyDisabled === undefined ? {} : { historyDisabled }),
      };
    });

  if (lines.length === 0) {
    throw new Error('AI lines config must contain at least one enabled line');
  }

  const defaultLineId =
    options.defaultLineOverride ||
    requireString(file.defaultLineId, 'defaultLineId');
  if (!lines.some((line) => line.id === defaultLineId)) {
    throw new Error(`Default AI line "${defaultLineId}" is not enabled`);
  }

  return { defaultLineId, lines };
}
