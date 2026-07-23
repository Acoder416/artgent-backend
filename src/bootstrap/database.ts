import * as mysql from 'mysql2/promise';

export interface DatabaseConnection {
  execute(statement: string): Promise<unknown>;
  end(): Promise<void>;
}

interface DatabaseConnectionOptions {
  host: string;
  port: number;
  user: string;
  password: string;
}

export type DatabaseConnector = (
  options: DatabaseConnectionOptions,
) => Promise<DatabaseConnection>;

const connectToMysql: DatabaseConnector = (options) =>
  mysql.createConnection(options);

export async function ensureDatabaseExists(
  config: Record<string, string | undefined>,
  connect: DatabaseConnector = connectToMysql,
): Promise<void> {
  const database = config.DB_DATABASE || 'artgen';
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error(`Invalid database name: ${database}`);
  }

  const connection = await connect({
    host: config.DB_HOST || 'localhost',
    port: Number.parseInt(config.DB_PORT || '3306', 10),
    user: config.DB_USERNAME || 'artgen',
    password: config.DB_PASSWORD || '',
  });

  try {
    await connection.execute(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await connection.end();
  }
}
