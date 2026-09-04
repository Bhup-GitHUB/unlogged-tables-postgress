import express, { type NextFunction, type Request, type Response } from "express";
import { Pool } from "pg";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({ connectionString: databaseUrl });

app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_request: Request, response: Response, next: NextFunction) => {
  try {
    await pool.query("SELECT 1");
    response.json({ status: "ok" });
  } catch (error) {
    next(error);
  }
});

app.get("/cache/:key", async (request: Request, response: Response, next: NextFunction) => {
  try {
    const result = await pool.query<{ value: unknown }>(
      "SELECT value FROM cache_entries WHERE cache_key = $1 AND expires_at > NOW()",
      [request.params.key]
    );

    if (result.rowCount === 0) {
      await pool.query("DELETE FROM cache_entries WHERE cache_key = $1", [request.params.key]);
      response.status(404).json({ error: "Cache entry not found" });
      return;
    }

    response.json({ key: request.params.key, value: result.rows[0].value });
  } catch (error) {
    next(error);
  }
});

app.put("/cache/:key", async (request: Request, response: Response, next: NextFunction) => {
  try {
    const { value, ttlSeconds = 300 } = request.body ?? {};
    const ttl = Number(ttlSeconds);

    if (!Object.prototype.hasOwnProperty.call(request.body ?? {}, "value")) {
      response.status(400).json({ error: "value is required" });
      return;
    }

    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400) {
      response.status(400).json({ error: "ttlSeconds must be an integer between 1 and 86400" });
      return;
    }

    await pool.query(
      `INSERT INTO cache_entries (cache_key, value, expires_at)
       VALUES ($1, $2::jsonb, NOW() + ($3 * INTERVAL '1 second'))
       ON CONFLICT (cache_key)
       DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      [request.params.key, JSON.stringify(value), ttl]
    );

    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.delete("/cache/:key", async (request: Request, response: Response, next: NextFunction) => {
  try {
    await pool.query("DELETE FROM cache_entries WHERE cache_key = $1", [request.params.key]);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  response.status(500).json({ error: "Internal server error" });
});

async function start() {
  await pool.query(`
    CREATE UNLOGGED TABLE IF NOT EXISTS cache_entries (
      cache_key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS cache_entries_expires_at_idx
    ON cache_entries (expires_at)
  `);

  const server = app.listen(port, () => {
    console.log(`Cache service listening on port ${port}`);
  });

  const shutdown = async () => {
    server.close();
    await pool.end();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

start().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
