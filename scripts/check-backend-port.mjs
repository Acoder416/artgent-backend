import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { isPortOpen, parsePort } from './dev-workspace-ports.mjs';

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readDevelopmentEnvironment() {
  try {
    return parse(readFileSync(resolve(backendDir, '.env.development'), 'utf8'));
  } catch {
    return {};
  }
}

const developmentEnvironment = readDevelopmentEnvironment();
const port = parsePort(
  process.env.PORT || developmentEnvironment.PORT || '3001',
  'backend',
);

if (await isPortOpen(port)) {
  console.error(
    `Port ${port} is already in use. The ArtGen backend may already be running; use "npm run dev:workspace" to reuse it or configure a different PORT.`,
  );
  process.exit(1);
}
