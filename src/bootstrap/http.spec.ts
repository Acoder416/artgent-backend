import { createServer, Server } from 'node:net';
import {
  assertPortAvailable,
  isCorsEnabled,
  parseAllowedOrigins,
  parsePort,
  PortInUseError,
} from './http';

describe('HTTP bootstrap configuration', () => {
  it('keeps CORS disabled unless it is explicitly enabled', () => {
    expect(isCorsEnabled(undefined)).toBe(false);
    expect(isCorsEnabled('')).toBe(false);
    expect(isCorsEnabled('false')).toBe(false);
    expect(isCorsEnabled('true')).toBe(true);
  });

  it('rejects invalid CORS toggle values', () => {
    expect(() => isCorsEnabled('yes')).toThrow(
      'ENABLE_CORS must be \"true\" or \"false\"',
    );
  });
  it('parses a comma-separated CORS allowlist', () => {
    expect(
      parseAllowedOrigins('http://localhost:3016, https://image.lzljz.top/'),
    ).toEqual(['http://localhost:3016', 'https://image.lzljz.top']);
  });

  it('rejects an empty CORS allowlist', () => {
    expect(() => parseAllowedOrigins('')).toThrow(
      'CORS_ALLOWED_ORIGINS must contain at least one origin',
    );
  });
  it('rejects wildcard CORS origins', () => {
    expect(() => parseAllowedOrigins('*')).toThrow(
      'CORS_ALLOWED_ORIGINS cannot contain "*"',
    );
  });

  it('validates the configured port', () => {
    expect(parsePort('3001')).toBe(3001);
    expect(() => parsePort('random')).toThrow('PORT must be an integer');
  });

  it('reports a concise error when the port is occupied', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    await expect(assertPortAvailable(port)).rejects.toBeInstanceOf(
      PortInUseError,
    );

    await close(server);
  });
});

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
