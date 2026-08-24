import { NestFactory } from '@nestjs/core';
import { resolve } from 'node:path';
import { resolveEnvironment } from '../bootstrap/environment';
import {
  ImageVariantBackfillOptions,
  ImageVariantBackfillService,
} from './image-variant-backfill.service';

export interface ImageVariantBackfillCommand {
  environment: 'development' | 'production';
  options: ImageVariantBackfillOptions;
}

function integerOption(args: string[], name: string): number | undefined {
  const prefix = `--${name}=`;
  const argument = args.find((value) => value.startsWith(prefix));
  if (!argument) return undefined;
  const value = Number(argument.slice(prefix.length));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

export function parseImageVariantBackfillCommand(
  args: string[],
  environmentVariables: NodeJS.ProcessEnv,
): ImageVariantBackfillCommand {
  const supported = new Set([
    '--apply',
    ...args.filter((value) =>
      [
        '--env=',
        '--after-id=',
        '--batch-size=',
        '--concurrency=',
      ].some((prefix) => value.startsWith(prefix)),
    ),
  ]);
  const unsupported = args.find((value) => !supported.has(value));
  if (unsupported) throw new Error(`Unsupported option: ${unsupported}`);

  return {
    environment: resolveEnvironment(args, environmentVariables),
    options: {
      apply: args.includes('--apply'),
      afterId: integerOption(args, 'after-id'),
      batchSize: integerOption(args, 'batch-size'),
      concurrency: integerOption(args, 'concurrency'),
    },
  };
}

async function main(): Promise<void> {
  const command = parseImageVariantBackfillCommand(
    process.argv.slice(2),
    process.env,
  );
  process.env.NODE_ENV = command.environment;
  const { ImageVariantBackfillModule } = await import(
    './image-variant-backfill.module.js'
  );
  const application = await NestFactory.createApplicationContext(
    ImageVariantBackfillModule,
    { logger: ['error', 'warn'] },
  );

  try {
    const result = await application
      .get(ImageVariantBackfillService)
      .run(command.options);
    console.log(
      JSON.stringify(
        {
          mode: command.options.apply ? 'apply' : 'dry-run',
          ...result,
        },
        null,
        2,
      ),
    );
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    await application.close();
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPath === __filename) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
