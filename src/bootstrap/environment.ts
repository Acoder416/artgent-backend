import { randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'dotenv';

export type AppEnvironment = 'development' | 'production';

export function resolveEnvironment(
  args: string[],
  environmentVariables: NodeJS.ProcessEnv,
): AppEnvironment {
  const argument = args.find((value) => value.startsWith('--env='));
  const requested =
    argument?.slice('--env='.length) ??
    environmentVariables.NODE_ENV ??
    'development';
  if (requested !== 'development' && requested !== 'production') {
    throw new Error(`Unsupported environment: ${requested}`);
  }
  return requested;
}

interface InitializeEnvironmentOptions {
  environment: AppEnvironment;
  projectDir: string;
  environmentVariables?: NodeJS.ProcessEnv;
  generateSecret?: () => string;
  generateAdminPassword?: () => string;
}

const placeholderValues = new Set([
  '',
  'your_jwt_secret_here',
  'your_admin_username_here',
  'your_admin_email_here',
  'your_admin_password_here',
]);

function hasUsableValue(value: string | undefined): value is string {
  return value !== undefined && !placeholderValues.has(value.trim());
}

function hasUsableJwtSecret(value: string | undefined): value is string {
  return hasUsableValue(value) && value.length >= 32;
}

function requireConfiguredValue(
  fileValue: string | undefined,
  environmentValue: string | undefined,
  key: string,
  envFileName: string,
): string {
  if (hasUsableValue(fileValue)) {
    return fileValue;
  }
  if (hasUsableValue(environmentValue)) {
    return environmentValue;
  }

  throw new Error(`${key} must be configured in ${envFileName}`);
}

function setEnvironmentValue(
  content: string,
  key: string,
  value: string,
): string {
  const line = `${key}=${value}`;
  const expression = new RegExp(`^${key}=.*$`, 'm');

  if (expression.test(content)) {
    return content.replace(expression, line);
  }

  const prefix = content.length === 0 ? '' : `${content.trimEnd()}\n`;
  return `${prefix}${line}\n`;
}

export function initializeEnvironment(
  options: InitializeEnvironmentOptions,
): Record<string, string> {
  const envFileName = `.env.${options.environment}`;
  const envFile = resolve(options.projectDir, envFileName);
  let content = existsSync(envFile)
    ? readFileSync(envFile, 'utf8')
    : `NODE_ENV=${options.environment}\n`;
  let fileConfig = parse(content);
  const environmentConfig = options.environmentVariables ?? {};
  const jwtSecret = hasUsableJwtSecret(fileConfig.JWT_SECRET)
    ? fileConfig.JWT_SECRET
    : hasUsableJwtSecret(environmentConfig.JWT_SECRET)
      ? environmentConfig.JWT_SECRET
      : (
          options.generateSecret ??
          (() => randomBytes(48).toString('base64url'))
        )();
  const adminUsername = requireConfiguredValue(
    fileConfig.ADMIN_USERNAME,
    environmentConfig.ADMIN_USERNAME,
    'ADMIN_USERNAME',
    envFileName,
  );
  const adminEmail = requireConfiguredValue(
    fileConfig.ADMIN_EMAIL,
    environmentConfig.ADMIN_EMAIL,
    'ADMIN_EMAIL',
    envFileName,
  );
  const adminPassword = hasUsableValue(fileConfig.ADMIN_PASSWORD)
    ? fileConfig.ADMIN_PASSWORD
    : hasUsableValue(environmentConfig.ADMIN_PASSWORD)
      ? environmentConfig.ADMIN_PASSWORD
      : (
          options.generateAdminPassword ??
          (() => randomBytes(32).toString('base64url'))
        )();
  const requiredValues = {
    JWT_SECRET: jwtSecret,
    ADMIN_USERNAME: adminUsername,
    ADMIN_EMAIL: adminEmail,
    ADMIN_PASSWORD: adminPassword,
  };

  if (
    Object.entries(requiredValues).some(
      ([key, value]) => fileConfig[key] !== value,
    )
  ) {
    for (const [key, value] of Object.entries(requiredValues)) {
      content = setEnvironmentValue(content, key, value);
    }
    writeFileSync(envFile, content, 'utf8');
    fileConfig = parse(content);
  }

  return {
    ...fileConfig,
    ...Object.fromEntries(
      Object.entries(environmentConfig).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...requiredValues,
  };
}
