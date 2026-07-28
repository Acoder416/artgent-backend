import { createServer, Server } from 'node:net';
import {
  assertPortAvailable,
  parseAllowedOrigins,
  parsePort,
  PortInUseError,
} from './http';

describe('HTTP bootstrap configuration', () => {
  it('parses a comma-separated CORS allowlist', () => {
    expect(
      parseAllowedOrigins('http://localhost:3016, https://image.lzljz.top/'),
    ).toEqual(['http://localhost:3016', 'https://image.lzljz.top']);
  });

  it('rejects wildcard CORS with credentials', () => {
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
