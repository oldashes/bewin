const { Pool } = require("pg");

const SSL_QUERY_KEYS = ["sslmode", "sslcert", "sslkey", "sslrootcert"];

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function buildSslConnectionConfig(connectionString, caBase64) {
  if (!caBase64) return { connectionString };

  const ca = Buffer.from(caBase64, "base64").toString("utf8");
  if (!ca.includes("-----BEGIN CERTIFICATE-----") || !ca.includes("-----END CERTIFICATE-----")) {
    throw new Error("Database SSL CA must be a base64-encoded PEM certificate");
  }

  const url = new URL(connectionString);
  for (const key of SSL_QUERY_KEYS) url.searchParams.delete(key);

  return {
    connectionString: url.toString(),
    ssl: {
      ca,
      rejectUnauthorized: true,
    },
  };
}

function buildDatabasePoolConfig(connectionString, env = process.env) {
  if (!connectionString) throw new Error("DATABASE_URL is required");

  return {
    ...buildSslConnectionConfig(connectionString, env.DB_SSL_CA_BASE64),
    // A pool is created per warm serverless instance. Keeping one short-lived
    // connection per instance prevents a burst of Vercel instances from
    // exhausting small managed PostgreSQL plans.
    max: boundedInteger(env.DB_POOL_MAX, 1, 1, 10),
    connectionTimeoutMillis: boundedInteger(env.DB_CONNECTION_TIMEOUT_MS, 15000, 1000, 60000),
    idleTimeoutMillis: boundedInteger(env.DB_IDLE_TIMEOUT_MS, 60000, 1000, 60000),
    maxLifetimeSeconds: boundedInteger(env.DB_POOL_MAX_LIFETIME_SECONDS, 300, 5, 600),
    allowExitOnIdle: true,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5000,
    application_name: env.DB_APPLICATION_NAME || "bewin",
  };
}

function isTransientDatabaseError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("connection terminated") ||
    message.includes("connection timeout") ||
    message.includes("timeout exceeded when trying to connect") ||
    message.includes("connection reset") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("server closed the connection")
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDatabasePool(connectionString = process.env.DATABASE_URL, env = process.env) {
  const pool = new Pool(buildDatabasePoolConfig(connectionString, env));
  const query = pool.query.bind(pool);
  pool.query = async (...args) => {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await query(...args);
      } catch (error) {
        lastError = error;
        if (!isTransientDatabaseError(error) || attempt === 2) throw error;
        await delay(250 * 2 ** attempt);
      }
    }
    throw lastError;
  };
  return pool;
}

async function connectDatabaseClient(pool) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await pool.connect();
    } catch (error) {
      lastError = error;
      if (!isTransientDatabaseError(error) || attempt === 2) throw error;
      await delay(250 * 2 ** attempt);
    }
  }
  throw lastError;
}

module.exports = {
  buildDatabasePoolConfig,
  buildSslConnectionConfig,
  connectDatabaseClient,
  createDatabasePool,
  isTransientDatabaseError,
};
