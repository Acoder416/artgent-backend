import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initializeEnvironment } from './environment';

describe('initializeEnvironment administrator credentials', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'artgen-admin-environment-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('persists generated administrator credentials for later restarts', () => {
    const envFile = join(projectDir, '.env.development');
    writeFileSync(
      envFile,
      `NODE_ENV=development\nJWT_SECRET=${'j'.repeat(64)}\nADMIN_USERNAME=local-owner\nADMIN_EMAIL=owner@example.com\n`,
      'utf8',
    );

    const config = initializeEnvironment({
      environment: 'development',
      projectDir,
      generateAdminPassword: () => 'generated-admin-password',
    });

    expect(config).toMatchObject({
      ADMIN_USERNAME: 'local-owner',
      ADMIN_EMAIL: 'owner@example.com',
      ADMIN_PASSWORD: 'generated-admin-password',
    });
    expect(readFileSync(envFile, 'utf8')).toContain(
      'ADMIN_PASSWORD=generated-admin-password',
    );
  });
});
