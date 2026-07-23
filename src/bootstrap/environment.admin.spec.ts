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
      'NODE_ENV=development\nJWT_SECRET=existing-jwt-secret\n',
      'utf8',
    );

    const config = initializeEnvironment({
      environment: 'development',
      projectDir,
      generateAdminPassword: () => 'generated-admin-password',
    });

    expect(config).toMatchObject({
      ADMIN_USERNAME: 'admin',
      ADMIN_EMAIL: 'admin@artgen.local',
      ADMIN_PASSWORD: 'generated-admin-password',
    });
    expect(readFileSync(envFile, 'utf8')).toContain(
      'ADMIN_PASSWORD=generated-admin-password',
    );
  });
});
