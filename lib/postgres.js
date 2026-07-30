const { Pool } = require("pg");

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function buildDatabasePoolConfig(connectionString, env = process.env) {
  if (!connectionString) throw new Error("DATABASE_URL is required");

  return {
    connectionString,
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
  createDatabasePool,
};
