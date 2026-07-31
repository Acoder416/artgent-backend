import assert from 'node:assert/strict';
import test from 'node:test';
import { terminateProcessTree } from './dev-process.mjs';

test('Windows shutdown terminates the complete child process tree', async () => {
  const terminatedPids = [];
  const child = {
    pid: 4321,
    exitCode: null,
    signalCode: null,
    kill: () => assert.fail('direct child kill should not be used'),
  };

  await terminateProcessTree(child, {
    platform: 'win32',
    killWindowsProcessTree: async (pid) => terminatedPids.push(pid),
  });

  assert.deepEqual(terminatedPids, [4321]);
});

test('shutdown ignores a child that has already exited', async () => {
  let attemptedTermination = false;
  const child = {
    pid: 4321,
    exitCode: 0,
    signalCode: null,
    kill: () => {
      attemptedTermination = true;
    },
  };

  await terminateProcessTree(child, {
    platform: 'win32',
    killWindowsProcessTree: async () => {
      attemptedTermination = true;
    },
  });

  assert.equal(attemptedTermination, false);
});
