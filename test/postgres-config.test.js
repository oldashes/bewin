const test = require("node:test");
const assert = require("node:assert/strict");

const { buildDatabasePoolConfig } = require("../lib/postgres");

test("uses conservative serverless PostgreSQL pool defaults", () => {
  const config = buildDatabasePoolConfig("postgresql://example.invalid/db", {});

  assert.equal(config.max, 2);
  assert.equal(config.connectionTimeoutMillis, 10000);
  assert.equal(config.idleTimeoutMillis, 10000);
  assert.equal(config.allowExitOnIdle, true);
  assert.equal(config.application_name, "bewin");
});

test("bounds database pool environment settings", () => {
  const config = buildDatabasePoolConfig("postgresql://example.invalid/db", {
    DB_POOL_MAX: "99",
    DB_CONNECTION_TIMEOUT_MS: "200",
    DB_IDLE_TIMEOUT_MS: "90000",
    DB_APPLICATION_NAME: "bewin-test",
  });

  assert.equal(config.max, 10);
  assert.equal(config.connectionTimeoutMillis, 1000);
  assert.equal(config.idleTimeoutMillis, 60000);
  assert.equal(config.application_name, "bewin-test");
});
