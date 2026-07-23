import {
  DatabaseConnection,
  DatabaseConnector,
  ensureDatabaseExists,
} from './database';

class FakeMysqlServer {
  readonly databases = new Set<string>();

  readonly connect: DatabaseConnector = () =>
    Promise.resolve({
      execute: (statement: string) => {
        const database = statement.match(
          /^CREATE DATABASE IF NOT EXISTS `([^`]+)`/,
        )?.[1];
        if (database) {
          this.databases.add(database);
        }
        return Promise.resolve(undefined);
      },
      end: () => Promise.resolve(undefined),
    } satisfies DatabaseConnection);
}

describe('ensureDatabaseExists', () => {
  it('creates the configured database when the MySQL instance has none', async () => {
    const mysql = new FakeMysqlServer();

    await ensureDatabaseExists(
      {
        DB_HOST: 'localhost',
        DB_PORT: '3306',
        DB_USERNAME: 'artgen',
        DB_PASSWORD: 'secret',
        DB_DATABASE: 'artgen',
      },
      mysql.connect,
    );

    expect(mysql.databases.has('artgen')).toBe(true);
  });
});
