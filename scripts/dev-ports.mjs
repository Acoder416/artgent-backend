import { createConnection } from 'node:net';

export function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label} port: ${value}`);
  }
  return port;
}

export function isPortOpen(port) {
  return new Promise((resolveCheck) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.setTimeout(800);
    socket.once('connect', () => {
      socket.destroy();
      resolveCheck(true);
    });
    const unavailable = () => {
      socket.destroy();
      resolveCheck(false);
    };
    socket.once('timeout', unavailable);
    socket.once('error', unavailable);
  });
}

export async function findAvailablePort(startingPort, options = {}) {
  const checkPort = options.isPortOpen ?? isPortOpen;

  for (let port = startingPort; port <= 65535; port += 1) {
    if (!(await checkPort(port))) return port;
  }

  throw new Error(`No available port found from ${startingPort} to 65535.`);
}
