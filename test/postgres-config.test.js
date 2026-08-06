const test = require("node:test");
const assert = require("node:assert/strict");

const { buildDatabasePoolConfig, buildSslConnectionConfig, isTransientDatabaseError } = require("../lib/postgres");

test("uses conservative serverless PostgreSQL pool defaults", () => {
  const config = buildDatabasePoolConfig("postgresql://example.invalid/db", {});

  assert.equal(config.max, 1);
  assert.equal(config.connectionTimeoutMillis, 15000);
  assert.equal(config.idleTimeoutMillis, 60000);
  assert.equal(config.maxLifetimeSeconds, 300);
  assert.equal(config.allowExitOnIdle, true);
  assert.equal(config.application_name, "bewin");
});

test("bounds database pool environment settings", () => {
  const config = buildDatabasePoolConfig("postgresql://example.invalid/db", {
    DB_POOL_MAX: "99",
    DB_CONNECTION_TIMEOUT_MS: "200",
    DB_IDLE_TIMEOUT_MS: "90000",
    DB_POOL_MAX_LIFETIME_SECONDS: "9999",
    DB_APPLICATION_NAME: "bewin-test",
  });

  assert.equal(config.max, 10);
  assert.equal(config.connectionTimeoutMillis, 1000);
  assert.equal(config.idleTimeoutMillis, 60000);
  assert.equal(config.maxLifetimeSeconds, 600);
  assert.equal(config.application_name, "bewin-test");
});

test("recognizes retryable database connection failures", () => {
  assert.equal(isTransientDatabaseError(new Error("Connection terminated unexpectedly")), true);
  assert.equal(isTransientDatabaseError(new Error("connect ETIMEDOUT 10.0.0.1")), true);
  assert.equal(isTransientDatabaseError(new Error("timeout exceeded when trying to connect")), true);
  assert.equal(isTransientDatabaseError(new Error("duplicate key value violates unique constraint")), false);
});

test("verifies PostgreSQL with a base64-encoded CA certificate", () => {
  const ca = "-----BEGIN CERTIFICATE-----\ntest-ca\n-----END CERTIFICATE-----\n";
  const config = buildSslConnectionConfig(
    "postgresql://user:password@example.invalid/db?sslmode=require",
    Buffer.from(ca).toString("base64"),
  );

  assert.equal(config.connectionString, "postgresql://user:password@example.invalid/db");
  assert.deepEqual(config.ssl, { ca, rejectUnauthorized: true });
});

test("rejects malformed PostgreSQL CA configuration", () => {
  assert.throws(
    () => buildSslConnectionConfig("postgresql://example.invalid/db", Buffer.from("not a cert").toString("base64")),
    /base64-encoded PEM certificate/,
  );
});
