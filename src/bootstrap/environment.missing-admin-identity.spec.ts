import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initializeEnvironment } from './environment';

describe('initializeEnvironment administrator identity', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'artgen-admin-identity-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('rejects startup when the administrator identity is not configured', () => {
    writeFileSync(
      join(projectDir, '.env.production'),
      `NODE_ENV=production\nJWT_SECRET=${'j'.repeat(64)}\n`,
      'utf8',
    );

    expect(() =>
      initializeEnvironment({
        environment: 'production',
        projectDir,
      }),
    ).toThrow('ADMIN_USERNAME must be configured in .env.production');
  });
});
