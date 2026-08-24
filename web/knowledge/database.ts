import { Client, type QueryResultRow } from 'pg';

export type Database = {
  query<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<Row[]>;
  execute(sql: string, values?: readonly unknown[]): Promise<number>;
};

class PgDatabase implements Database {
  constructor(private readonly client: Client) {}

  async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<Row[]> {
    const result = await this.client.query<Row>(sql, [...values]);
    return result.rows;
  }

  async execute(sql: string, values: readonly unknown[] = []): Promise<number> {
    const result = await this.client.query(sql, [...values]);
    return result.rowCount ?? 0;
  }
}

function workerConnectionString(connectionString: string): string {
  const url = new URL(connectionString);
  if (['require', 'prefer'].includes(url.searchParams.get('sslmode') || '')) {
    url.searchParams.set('uselibpqcompat', 'true');
  }
  return url.toString();
}

export async function withDatabase<Result>(
  connectionString: string,
  operation: (database: Database) => Promise<Result>,
): Promise<Result> {
  const client = new Client({ connectionString: workerConnectionString(connectionString) });
  await client.connect();
  const database = new PgDatabase(client);
  try {
    await client.query('begin');
    await client.query("set local statement_timeout = '90s'");
    const result = await operation(database);
    await client.query('commit');
    return result;
  } catch (error) {
    try { await client.query('rollback'); } catch { /* preserve the original transaction error */ }
    throw error;
  } finally {
    try { await client.end(); } catch { /* Hyperdrive may already have closed a failed socket */ }
  }
}

function isTransientConnectionError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return message.includes('connection terminated')
    || message.includes('connection error')
    || message.includes('not queryable')
    || message.includes('econnreset')
    || message.includes('socket');
}

export async function withDatabaseRetry<Result>(
  connectionString: string,
  operation: (database: Database) => Promise<Result>,
  attempts = 3,
): Promise<Result> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await withDatabase(connectionString, operation);
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      lastError = error;
      if (!isTransientConnectionError(error) || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
  throw lastError;
}

export async function withReadOnlyDatabase<Result>(
  connectionString: string,
  operation: (database: Database) => Promise<Result>,
): Promise<Result> {
  return withDatabase(connectionString, async (database) => {
    await database.execute('set transaction read only');
    return operation(database);
  });
}
