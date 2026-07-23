import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initializeEnvironment } from './environment';

describe('initializeEnvironment weak JWT secrets', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'artgen-weak-jwt-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('replaces a short JWT secret with a generated strong value', () => {
    const envFile = join(projectDir, '.env.production');
    writeFileSync(
      envFile,
      'NODE_ENV=production\nJWT_SECRET=change-me\n',
      'utf8',
    );
    const generatedSecret = 'a'.repeat(64);

    const config = initializeEnvironment({
      environment: 'production',
      projectDir,
      generateSecret: () => generatedSecret,
    });

    expect(config.JWT_SECRET).toBe(generatedSecret);
    expect(readFileSync(envFile, 'utf8')).toContain(
      `JWT_SECRET=${generatedSecret}`,
    );
  });
});
