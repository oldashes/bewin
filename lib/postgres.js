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
    max: boundedInteger(env.DB_POOL_MAX, 2, 1, 10),
    connectionTimeoutMillis: boundedInteger(env.DB_CONNECTION_TIMEOUT_MS, 10000, 1000, 60000),
    idleTimeoutMillis: boundedInteger(env.DB_IDLE_TIMEOUT_MS, 10000, 1000, 60000),
    allowExitOnIdle: true,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    application_name: env.DB_APPLICATION_NAME || "bewin",
  };
}

function createDatabasePool(connectionString = process.env.DATABASE_URL, env = process.env) {
  return new Pool(buildDatabasePoolConfig(connectionString, env));
}

module.exports = {
  buildDatabasePoolConfig,
  buildSslConnectionConfig,
  createDatabasePool,
};
