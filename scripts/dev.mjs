import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { findAvailablePort, parsePort } from './dev-ports.mjs';
import { runManagedProcess } from './dev-process.mjs';
import { clearBackendRuntime, writeBackendRuntime } from './dev-runtime.mjs';

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function readDevelopmentEnvironment() {
  try {
    return parse(
      await readFile(resolve(backendDir, '.env.development'), 'utf8'),
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

async function run() {
  const developmentEnvironment = await readDevelopmentEnvironment();
  const requestedPort = parsePort(
    process.env.PORT || developmentEnvironment.PORT || '3001',
    'backend',
  );
  const port = await findAvailablePort(requestedPort);

  if (port !== requestedPort) {
    console.log(`Port ${requestedPort} is in use; using ${port} instead.`);
  }

  await writeBackendRuntime({ port, pid: process.pid });
  console.log(`ArtGen backend development URL: http://localhost:${port}`);

  const nestCli = resolve(
    backendDir,
    'node_modules',
    '@nestjs',
    'cli',
    'bin',
    'nest.js',
  );
  const result = await runManagedProcess(
    process.execPath,
    [nestCli, 'start', '--watch', ...process.argv.slice(2)],
    {
      cwd: backendDir,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PORT: String(port),
      },
      stdio: 'inherit',
    },
  );

  await clearBackendRuntime(process.pid);
  process.exitCode = result.code ?? (result.signal ? 1 : 0);
}

run().catch(async (error) => {
  await clearBackendRuntime(process.pid);
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
