import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  clearBackendRuntime,
  readBackendRuntime,
  waitForBackendRuntime,
  writeBackendRuntime,
} from './dev-runtime.mjs';

test('backend runtime descriptor round-trips and is owner-cleaned', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'artgen-dev-runtime-'));
  const file = join(directory, 'backend.json');
  context.after(() => rm(directory, { recursive: true, force: true }));

  await writeBackendRuntime({ port: 3002, pid: 1234 }, file);
  assert.deepEqual(await readBackendRuntime(file), {
    service: 'artgen-backend',
    url: 'http://127.0.0.1:3002',
    port: 3002,
    pid: 1234,
  });

  await clearBackendRuntime(9999, file);
  assert.notEqual(await readBackendRuntime(file), null);
  await clearBackendRuntime(1234, file);
  assert.equal(await readBackendRuntime(file), null);
});

test('stopping the latest backend restores the previous runtime descriptor', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'artgen-dev-runtime-'));
  const file = join(directory, 'backend.json');
  context.after(() => rm(directory, { recursive: true, force: true }));

  await writeBackendRuntime({ port: 3001, pid: 1234 }, file);
  await writeBackendRuntime({ port: 3002, pid: 5678 }, file);
  await clearBackendRuntime(5678, file);

  assert.deepEqual(await readBackendRuntime(file), {
    service: 'artgen-backend',
    url: 'http://127.0.0.1:3001',
    port: 3001,
    pid: 1234,
  });
});

test('frontend waits for the published backend to become healthy', async () => {
  let attempts = 0;
  const url = await waitForBackendRuntime({
    timeoutMs: 100,
    readRuntime: async () => ({
      service: 'artgen-backend',
      url: 'http://127.0.0.1:3002',
      port: 3002,
      pid: 1234,
    }),
    isBackendHealthy: async () => {
      attempts += 1;
      return attempts > 1;
    },
    wait: async () => {},
  });

  assert.equal(url, 'http://127.0.0.1:3002');
  assert.equal(attempts, 2);
});

test('frontend falls back to a healthy previous backend runtime', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'artgen-dev-runtime-'));
  const file = join(directory, 'backend.json');
  context.after(() => rm(directory, { recursive: true, force: true }));

  await writeBackendRuntime({ port: 3001, pid: 1234 }, file);
  await writeBackendRuntime({ port: 3002, pid: 5678 }, file);

  const checkedUrls = [];
  const url = await waitForBackendRuntime({
    timeoutMs: 100,
    file,
    isBackendHealthy: async (candidateUrl) => {
      checkedUrls.push(candidateUrl);
      return candidateUrl === 'http://127.0.0.1:3001';
    },
    wait: async () => {},
  });

  assert.equal(url, 'http://127.0.0.1:3001');
  assert.deepEqual(checkedUrls, [
    'http://127.0.0.1:3002',
    'http://127.0.0.1:3001',
  ]);
});
