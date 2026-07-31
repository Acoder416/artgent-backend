import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import { findAvailablePort, isPortOpen, parsePort } from './dev-ports.mjs';

test('isPortOpen detects a listening port', async (context) => {
  const server = createServer();
  context.after(
    () =>
      new Promise((resolveClose) => {
        if (!server.listening) return resolveClose();
        server.close(resolveClose);
      }),
  );
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === 'object');

  assert.equal(await isPortOpen(address.port), true);
});

test('findAvailablePort skips occupied ports', async () => {
  const port = await findAvailablePort(3001, {
    isPortOpen: async (candidate) => candidate === 3001,
  });

  assert.equal(port, 3002);
});

test('parsePort validates configured ports', () => {
  assert.equal(parsePort('3001', 'backend'), 3001);
  assert.throws(() => parsePort('random', 'backend'), /Invalid backend port/);
});
