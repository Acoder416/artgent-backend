import { spawn } from 'node:child_process';

function killWindowsProcessTree(pid) {
  return new Promise((resolveKill, rejectKill) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', rejectKill);
    killer.once('exit', resolveKill);
  });
}

export async function terminateProcessTree(child, options = {}) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;

  const platform = options.platform ?? process.platform;
  const signal = options.signal ?? 'SIGTERM';

  if (platform === 'win32') {
    const killTree = options.killWindowsProcessTree ?? killWindowsProcessTree;
    try {
      await killTree(child.pid);
    } catch {
      child.kill(signal);
    }
    return;
  }

  const killGroup = options.killPosixProcessGroup ?? process.kill;
  try {
    killGroup(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export async function runManagedProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== 'win32',
  });
  let shutdownPromise;
  const signalHandlers = new Map();

  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      shutdownPromise ??= terminateProcessTree(child, { signal });
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  let result;
  try {
    result = await new Promise((resolveChild, rejectChild) => {
      child.once('error', rejectChild);
      child.once('exit', (code, signal) => resolveChild({ code, signal }));
    });
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
  }

  await shutdownPromise;
  return result;
}
