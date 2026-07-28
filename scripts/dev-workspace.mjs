import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import {
  findAvailablePort,
  isPortOpen,
  parsePort,
} from './dev-workspace-ports.mjs';

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceDir = resolve(backendDir, '..');
const frontendDir = resolve(workspaceDir, 'artgen-frontend');
const backendEnvironment = readEnvironment(
  resolve(backendDir, '.env.development'),
);
const frontendEnvironment = readEnvironment(
  resolve(frontendDir, '.env.development'),
);
const requestedBackendPort = parsePort(
  process.env.BACKEND_PORT ||
    process.env.PORT ||
    backendEnvironment.PORT ||
    '3001',
  'backend',
);
const requestedFrontendPort = parsePort(
  process.env.FRONTEND_PORT || frontendEnvironment.FRONTEND_PORT || '3000',
  'frontend',
);
const npmCli =
  process.env.npm_execpath ||
  resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const backendScript =
  process.env.BACKEND_WATCH === 'false' ? 'start' : 'start:dev';
const children = new Set();
let shuttingDown = false;

function readEnvironment(file) {
  try {
    return parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

async function isArtGenBackendRunning(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    const body = await response.json();
    return response.ok && body.service === 'artgen-backend';
  } catch {
    return false;
  }
}

function startNpm(args, cwd, environment = {}) {
  const child = spawn(process.execPath, [npmCli, ...args], {
    cwd,
    env: { ...process.env, ...environment },
    stdio: 'inherit',
    shell: false,
  });
  children.add(child);
  child.once('exit', (code) => {
    children.delete(child);
    if (!shuttingDown && code !== 0) {
      console.error(`npm exited with code ${code}`);
      void shutdown(code || 1);
    }
  });
  return child;
}

async function waitForBackend(child, port) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Backend exited with code ${child.exitCode}`);
    }
    if (await isArtGenBackendRunning(port)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error('Backend did not become healthy within 90 seconds');
}

async function stopChild(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolveStop) => {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      }).once('exit', resolveStop);
    });
  } else {
    child.kill('SIGTERM');
  }
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all(Array.from(children, stopChild));
  process.exit(exitCode);
}

async function main() {
  let backendPort = requestedBackendPort;
  let backendIsRunning = false;
  if (await isPortOpen(backendPort)) {
    backendIsRunning = await isArtGenBackendRunning(backendPort);
    if (backendIsRunning) {
      console.log(`Reusing ArtGen backend on http://localhost:${backendPort}`);
    } else {
      backendPort = await findAvailablePort(requestedBackendPort, {
        excludedPorts: new Set([requestedFrontendPort]),
      });
      console.warn(
        `Backend port ${requestedBackendPort} is occupied; using ${backendPort}.`,
      );
    }
  }

  if (!backendIsRunning) {
    console.log(`Starting ArtGen backend on http://localhost:${backendPort}`);
    const backend = startNpm(['run', backendScript], backendDir, {
      PORT: String(backendPort),
    });
    await waitForBackend(backend, backendPort);
  }

  const frontendPort = await findAvailablePort(requestedFrontendPort, {
    excludedPorts: new Set([backendPort]),
  });
  if (frontendPort !== requestedFrontendPort) {
    console.warn(
      `Frontend port ${requestedFrontendPort} is occupied; using ${frontendPort}.`,
    );
  }

  console.log(`Starting ArtGen frontend on http://localhost:${frontendPort}`);
  startNpm(['run', 'dev', '--', '--port', String(frontendPort)], frontendDir, {
    BACKEND_INTERNAL_URL: `http://127.0.0.1:${backendPort}`,
  });
}
process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  void shutdown(1);
});
