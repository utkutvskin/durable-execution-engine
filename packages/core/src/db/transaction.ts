import type { Pool, PoolClient } from "pg";

/**
 * Rolls back the open transaction of `client` and reports whether the
 * connection is still usable. A rollback that itself fails means the
 * connection is gone, so the client must not go back to the pool.
 */
export async function rollbackQuietly(client: PoolClient): Promise<boolean> {
  try {
    await client.query("rollback");
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `work` on a client taken from `pool` and returns its result. When
 * `work` throws, the client is rolled back, and a client whose rollback also
 * fails is destroyed instead of being returned to the pool, so a dead
 * connection is never handed to the next caller. The caller owns the
 * transaction: `work` issues its own `begin` and `commit`.
 */
export async function withClient<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    return await work(client);
  } catch (error) {
    broken = !(await rollbackQuietly(client));
    throw error;
  } finally {
    client.release(broken);
  }
}

/**
 * Runs `work` inside `begin` and `commit` on a client from `pool`. A throw
 * rolls the transaction back; see `withClient` for how a dead connection is
 * handled.
 */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withClient(pool, async (client) => {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  });
}
