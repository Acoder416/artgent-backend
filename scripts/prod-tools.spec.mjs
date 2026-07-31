import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import test from 'node:test';
import { runBackendProduction } from './prod.mjs';

test('production startup publishes its configured port and launches the built backend', async () => {
  const published = [];
  const cleared = [];
  let launched;

  const result = await runBackendProduction({
    args: ['--trace-warnings'],
    environment: { CUSTOM_VALUE: 'preserved' },
    productionEnvironment: { PORT: '4088' },
    ownerPid: 4321,
    writeRuntime: async (descriptor) => published.push(descriptor),
    clearRuntime: async (pid) => cleared.push(pid),
    runProcess: async (command, args, options) => {
      launched = { command, args, options };
      return { code: 0, signal: null };
    },
    logger: { log() {} },
  });

  assert.deepEqual(published, [{ port: 4088, pid: 4321 }]);
  assert.deepEqual(cleared, [4321]);
  assert.equal(result.code, 0);
  assert.equal(launched.command, process.execPath);
  assert.equal(basename(launched.args[0]), 'main.js');
  assert.deepEqual(launched.args.slice(1), [
    '--env=production',
    '--trace-warnings',
  ]);
  assert.equal(launched.options.env.NODE_ENV, 'production');
  assert.equal(launched.options.env.PORT, '4088');
  assert.equal(launched.options.env.CUSTOM_VALUE, 'preserved');
  assert.equal(launched.options.stdio, 'inherit');
});

test('npm run prod uses the runtime-publishing production launcher', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );

  assert.equal(packageJson.scripts.prod, 'node scripts/prod.mjs');
});
