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

  it('rejects startup when the administrator username is not configured', () => {
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

  it('rejects startup when the administrator email is not configured', () => {
    writeFileSync(
      join(projectDir, '.env.production'),
      `NODE_ENV=production\nJWT_SECRET=${'j'.repeat(64)}\nADMIN_USERNAME=owner\n`,
      'utf8',
    );

    expect(() =>
      initializeEnvironment({
        environment: 'production',
        projectDir,
      }),
    ).toThrow('ADMIN_EMAIL must be configured in .env.production');
  });

  it('accepts administrator identity from process environment variables', () => {
    writeFileSync(
      join(projectDir, '.env.production'),
      `NODE_ENV=production\nJWT_SECRET=${'j'.repeat(64)}\n`,
      'utf8',
    );

    const config = initializeEnvironment({
      environment: 'production',
      projectDir,
      environmentVariables: {
        ADMIN_USERNAME: 'environment-owner',
        ADMIN_EMAIL: 'environment-owner@example.com',
      },
      generateAdminPassword: () => 'generated-admin-password',
    });

    expect(config).toMatchObject({
      ADMIN_USERNAME: 'environment-owner',
      ADMIN_EMAIL: 'environment-owner@example.com',
      ADMIN_PASSWORD: 'generated-admin-password',
    });
  });
});
