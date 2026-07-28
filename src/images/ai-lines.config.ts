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
}

interface AiLinesFile {
  defaultLineId?: unknown;
  lines?: unknown;
}

export interface AiLineConnection {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
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
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
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

      return {
        id,
        name,
        baseUrl: normalizeBaseUrl(configuredBaseUrl, id),
        apiKey,
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
