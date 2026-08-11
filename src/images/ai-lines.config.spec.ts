import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAiLinesConfiguration } from './ai-lines.config';

describe('loadAiLinesConfiguration', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'artgen-ai-lines-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('loads any number of lines from the server-side config', () => {
    writeFileSync(
      join(projectDir, 'lines.json'),
      JSON.stringify({
        defaultLineId: 'line-c',
        lines: [
          {
            id: 'line-a',
            name: '线路 A',
            baseUrlEnv: 'LINE_A_URL',
            apiKeyEnv: 'LINE_A_KEY',
            streamEnabled: false,
            promptRewriteModel: 'gpt-5-5',
            maxConcurrency: 3,
            responseFormat: 'b64_json',
            historyDisabled: true,
          },
          {
            id: 'line-c',
            name: '线路 C',
            baseUrl: 'https://line-c.test/',
            apiKeyEnv: 'LINE_C_KEY',
          },
        ],
      }),
      'utf8',
    );
    const environment = new Map([
      ['LINE_A_URL', 'https://line-a.test'],
      ['LINE_A_KEY', 'a-key'],
      ['LINE_C_KEY', 'c-key'],
    ]);

    const result = loadAiLinesConfiguration({
      projectDir,
      configFile: 'lines.json',
      getEnvironmentValue: (key) => environment.get(key),
    });

    expect(result.defaultLineId).toBe('line-c');
    expect(result.lines).toEqual([
      {
        id: 'line-a',
        name: '线路 A',
        baseUrl: 'https://line-a.test',
        apiKey: 'a-key',
        streamEnabled: false,
        promptRewriteModel: 'gpt-5-5',
        maxConcurrency: 3,
        responseFormat: 'b64_json',
        historyDisabled: true,
      },
      {
        id: 'line-c',
        name: '线路 C',
        baseUrl: 'https://line-c.test',
        apiKey: 'c-key',
        streamEnabled: true,
        promptRewriteModel: 'gpt-5.4-mini',
        maxConcurrency: 10,
      },
    ]);
  });

  it('inherits global streaming and rewrite defaults for legacy lines', () => {
    writeFileSync(
      join(projectDir, 'lines.json'),
      JSON.stringify({
        defaultLineId: 'line-a',
        lines: [
          { id: 'line-a', name: '线路 A', baseUrl: 'https://line-a.test' },
        ],
      }),
      'utf8',
    );

    expect(
      loadAiLinesConfiguration({
        projectDir,
        configFile: 'lines.json',
        getEnvironmentValue: () => undefined,
        defaultStreamEnabled: false,
        defaultPromptRewriteModel: 'legacy-chat-model',
      }),
    ).toMatchObject({
      lines: [
        {
          streamEnabled: false,
          promptRewriteModel: 'legacy-chat-model',
          maxConcurrency: 10,
        },
      ],
    });
  });

  it.each([
    ['responseFormat', 'xml', 'responseFormat must be b64_json or url'],
    ['maxConcurrency', 0, 'maxConcurrency must be a positive integer'],
  ])('rejects invalid %s', (field, value, message) => {
    writeFileSync(
      join(projectDir, 'lines.json'),
      JSON.stringify({
        defaultLineId: 'line-a',
        lines: [
          {
            id: 'line-a',
            name: '线路 A',
            baseUrl: 'https://line-a.test',
            [field]: value,
          },
        ],
      }),
      'utf8',
    );

    expect(() =>
      loadAiLinesConfiguration({
        projectDir,
        configFile: 'lines.json',
        getEnvironmentValue: () => undefined,
      }),
    ).toThrow(message);
  });

  it('rejects a default line that is disabled or missing', () => {
    writeFileSync(
      join(projectDir, 'lines.json'),
      JSON.stringify({
        defaultLineId: 'line-b',
        lines: [
          { id: 'line-a', name: '线路 A', baseUrl: 'https://line-a.test' },
        ],
      }),
      'utf8',
    );

    expect(() =>
      loadAiLinesConfiguration({
        projectDir,
        configFile: 'lines.json',
        getEnvironmentValue: () => undefined,
      }),
    ).toThrow('Default AI line "line-b" is not enabled');
  });
});
