import pg from "pg";
import { readFileSync } from "node:fs";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? {
    rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false",
    ...(process.env.DATABASE_SSL_CA_PATH ? { ca: readFileSync(process.env.DATABASE_SSL_CA_PATH, "utf8") } : {}),
  } : undefined,
});

let databaseTestHooks = {};

export function setDatabaseTestHooks(hooks = {}) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Database test hooks are only available in NODE_ENV=test");
  }
  databaseTestHooks = hooks;
}

function observedQuery(target, text, params) {
  databaseTestHooks.onQuery?.({
    text: typeof text === "string" ? text : text?.text || "",
    params: params || (typeof text === "object" ? text.values : undefined),
  });
  return target.query(text, params);
}

export async function query(text, params) {
  return observedQuery(pool, text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  const transactionClient = typeof databaseTestHooks.onQuery !== "function"
    ? client
    : new Proxy(client, {
      get(target, property, receiver) {
        if (property === "query") {
          return (text, params) => observedQuery(target, text, params);
        }
        return Reflect.get(target, property, receiver);
      },
    });
  try {
    await transactionClient.query("begin");
    const result = await fn(transactionClient);
    await transactionClient.query("commit");
    return result;
  } catch (err) {
    await transactionClient.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
