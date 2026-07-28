import assert from 'node:assert/strict';
import test from 'node:test';
import { findAvailablePort, parsePort } from './dev-workspace-ports.mjs';

test('findAvailablePort skips occupied and excluded ports', async () => {
  const occupiedPorts = new Set([3000]);

  const port = await findAvailablePort(3000, {
    excludedPorts: new Set([3001]),
    isPortOpen: async (candidate) => occupiedPorts.has(candidate),
  });

  assert.equal(port, 3002);
});

test('findAvailablePort reports when no candidate remains', async () => {
  await assert.rejects(
    findAvailablePort(65535, {
      isPortOpen: async () => true,
    }),
    /No available port found/,
  );
});

test('parsePort validates configured ports', () => {
  assert.equal(parsePort('3001', 'backend'), 3001);
  assert.throws(() => parsePort('random', 'backend'), /Invalid backend port/);
});
