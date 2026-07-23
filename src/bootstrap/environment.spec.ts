import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initializeEnvironment } from './environment';

describe('initializeEnvironment', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'artgen-environment-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('persists one generated JWT secret for the selected environment', () => {
    const envFile = join(projectDir, '.env.production');
    writeFileSync(envFile, 'NODE_ENV=production\n', 'utf8');

    const first = initializeEnvironment({
      environment: 'production',
      projectDir,
      generateSecret: () => 'generated-jwt-secret',
    });
    const second = initializeEnvironment({
      environment: 'production',
      projectDir,
      generateSecret: () => 'different-secret',
    });

    expect(first.JWT_SECRET).toBe('generated-jwt-secret');
    expect(second.JWT_SECRET).toBe('generated-jwt-secret');
    expect(readFileSync(envFile, 'utf8')).toContain(
      'JWT_SECRET=generated-jwt-secret',
    );
  });
});
