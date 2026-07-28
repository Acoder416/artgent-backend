import { createConnection } from 'node:net';

export class PortInUseError extends Error {
  constructor(port: number) {
    super(
      `Port ${port} is already in use. The ArtGen backend may already be running; stop the existing process or configure a different PORT.`,
    );
    this.name = 'PortInUseError';
  }
}

export function parsePort(value: string | undefined): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `PORT must be an integer between 1 and 65535, received: ${value}`,
    );
  }
  return port;
}

export function parseAllowedOrigins(value: string | undefined): string[] {
  if (value === undefined) {
    throw new Error('CORS_ALLOWED_ORIGINS must be configured');
  }

  const origins = value
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);

  for (const origin of origins) {
    if (origin === '*') {
      throw new Error('CORS_ALLOWED_ORIGINS cannot contain "*"');
    }
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`Invalid CORS origin: ${origin}`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new Error(`Invalid CORS origin: ${origin}`);
    }
  }

  return origins;
}

export function assertPortAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(800);
    socket.once('connect', () => finish(new PortInUseError(port)));
    socket.once('timeout', () => finish());
    socket.once('error', () => finish());
  });
}
