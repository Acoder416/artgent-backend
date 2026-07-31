import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const backendRuntimeFile = resolve(
  backendDir,
  '.artgen-dev',
  'backend.json',
);

function runtimeDescriptor(port, pid) {
  return {
    service: 'artgen-backend',
    url: `http://127.0.0.1:${port}`,
    port,
    pid,
  };
}

function parseRuntimeChain(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    value.service !== 'artgen-backend' ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    !Number.isInteger(value.pid) ||
    value.pid < 1 ||
    value.url !== `http://127.0.0.1:${value.port}`
  ) {
    return null;
  }

  const descriptor = runtimeDescriptor(value.port, value.pid);
  if (value.previous === undefined) return descriptor;

  const previous = parseRuntimeChain(value.previous);
  return previous ? { ...descriptor, previous } : null;
}

async function readRuntimeChain(file) {
  try {
    return parseRuntimeChain(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return null;
  }
}

async function writeRuntimeChain(descriptor, file) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
}

function removeOwner(descriptor, ownerPid) {
  if (!descriptor) return { descriptor: null, removed: false };
  if (descriptor.pid === ownerPid) {
    return { descriptor: descriptor.previous ?? null, removed: true };
  }

  const previous = removeOwner(descriptor.previous, ownerPid);
  if (!previous.removed) return { descriptor, removed: false };

  const updated = runtimeDescriptor(descriptor.port, descriptor.pid);
  if (previous.descriptor) updated.previous = previous.descriptor;
  return { descriptor: updated, removed: true };
}

export async function writeBackendRuntime(
  { port, pid },
  file = backendRuntimeFile,
) {
  const descriptor = runtimeDescriptor(port, pid);
  const existing = removeOwner(await readRuntimeChain(file), pid).descriptor;
  const chain = existing ? { ...descriptor, previous: existing } : descriptor;
  await writeRuntimeChain(chain, file);
  return descriptor;
}

export async function readBackendRuntime(file = backendRuntimeFile) {
  const descriptor = await readRuntimeChain(file);
  return descriptor ? runtimeDescriptor(descriptor.port, descriptor.pid) : null;
}

export async function clearBackendRuntime(ownerPid, file = backendRuntimeFile) {
  const current = await readRuntimeChain(file);
  const updated = removeOwner(current, ownerPid);
  if (!updated.removed) return;

  if (updated.descriptor) {
    await writeRuntimeChain(updated.descriptor, file);
    return;
  }

  try {
    await unlink(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function isBackendHealthy(url) {
  try {
    const response = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.service === 'artgen-backend' && body?.status === 'ok';
  } catch {
    return false;
  }
}

const delay = (milliseconds) =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

export async function waitForBackendRuntime(options = {}) {
  const timeoutMs = options.timeoutMs ?? 60000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const readRuntime =
    options.readRuntime ??
    (() => readRuntimeChain(options.file ?? backendRuntimeFile));
  const checkHealth = options.isBackendHealthy ?? isBackendHealthy;
  const wait = options.wait ?? delay;
  const deadline = Date.now() + timeoutMs;

  do {
    for (
      let descriptor = await readRuntime();
      descriptor;
      descriptor = descriptor.previous
    ) {
      if (await checkHealth(descriptor.url)) return descriptor.url;
    }
    await wait(pollIntervalMs);
  } while (Date.now() < deadline);

  throw new Error(
    'ArtGen backend is not running. Start it with `npm run dev` in artgen-backend, then retry.',
  );
}
