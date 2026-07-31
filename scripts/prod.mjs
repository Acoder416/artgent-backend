import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { parsePort } from './dev-ports.mjs';
import { runManagedProcess } from './dev-process.mjs';
import { clearBackendRuntime, writeBackendRuntime } from './dev-runtime.mjs';

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function readProductionEnvironment() {
  try {
    return parse(
      await readFile(resolve(backendDir, '.env.production'), 'utf8'),
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

export async function runBackendProduction(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const environment = options.environment ?? process.env;
  const productionEnvironment =
    options.productionEnvironment ?? (await readProductionEnvironment());
  const ownerPid = options.ownerPid ?? process.pid;
  const writeRuntime = options.writeRuntime ?? writeBackendRuntime;
  const clearRuntime = options.clearRuntime ?? clearBackendRuntime;
  const runProcess = options.runProcess ?? runManagedProcess;
  const logger = options.logger ?? console;
  const projectDir = options.backendDir ?? backendDir;
  const port = parsePort(
    environment.PORT || productionEnvironment.PORT || '3001',
    'backend',
  );

  await writeRuntime({ port, pid: ownerPid });
  logger.log(`ArtGen backend production URL: http://localhost:${port}`);

  const mainFile = resolve(projectDir, 'dist', 'main.js');
  try {
    return await runProcess(
      process.execPath,
      [mainFile, '--env=production', ...args],
      {
        cwd: projectDir,
        env: {
          ...environment,
          NODE_ENV: 'production',
          PORT: String(port),
        },
        stdio: 'inherit',
      },
    );
  } finally {
    await clearRuntime(ownerPid);
  }
}

async function main() {
  const result = await runBackendProduction();
  process.exitCode = result.code ?? (result.signal ? 1 : 0);
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
