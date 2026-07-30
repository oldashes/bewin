#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

loadEnv();

const SOURCE_URL = process.env.MIGRATION_SOURCE_DATABASE_URL || process.env.DATABASE_URL;
const TARGET_URL = process.env.MIGRATION_TARGET_DATABASE_URL;

const DATE_CHECKS = {
  strategy_signals: "signal_date",
  strategy_feature_events: "signal_date",
  stock_daily_bars: "trade_date",
  market_daily_baselines: "trade_date",
  popularity_snapshots: "snapshot_date",
  sync_runs: "started_at",
};

async function main() {
  if (!SOURCE_URL || !TARGET_URL) {
    throw new Error("DATABASE_URL (or MIGRATION_SOURCE_DATABASE_URL) and MIGRATION_TARGET_DATABASE_URL are required");
  }
  if (SOURCE_URL === TARGET_URL) throw new Error("Source and target database URLs must be different");

  const source = createClient(SOURCE_URL, "bewin-migration-verify-source");
  const target = createClient(TARGET_URL, "bewin-migration-verify-target");

  try {
    await source.connect();
    await target.connect();

    const [sourceTables, targetTables] = await Promise.all([loadTables(source), loadTables(target)]);
    const tableNames = [...new Set([...sourceTables, ...targetTables])].sort();
    const results = [];

    for (const tableName of tableNames) {
      const sourceExists = sourceTables.includes(tableName);
      const targetExists = targetTables.includes(tableName);
      const [sourceStats, targetStats] = await Promise.all([
        sourceExists ? loadTableStats(source, tableName) : null,
        targetExists ? loadTableStats(target, tableName) : null,
      ]);
      results.push({
        table: tableName,
        sourceRows: sourceStats?.count ?? "missing",
        targetRows: targetStats?.count ?? "missing",
        sourceLatest: sourceStats?.latest ?? "-",
        targetLatest: targetStats?.latest ?? "-",
        matches:
          Boolean(sourceStats && targetStats) &&
          sourceStats.count === targetStats.count &&
          sourceStats.latest === targetStats.latest,
      });
    }

    console.table(results);
    const failures = results.filter((row) => !row.matches);
    if (failures.length) {
      throw new Error(`Migration verification failed for ${failures.length} table(s)`);
    }
    console.log(`Migration verification passed for ${results.length} table(s).`);
  } finally {
    await Promise.allSettled([source.end(), target.end()]);
  }
}

function createClient(connectionString, applicationName) {
  return new Client({
    connectionString,
    application_name: applicationName,
    connectionTimeoutMillis: 15000,
  });
}

async function loadTables(client) {
  const { rows } = await client.query(`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_type = 'BASE TABLE'
    order by table_name
  `);
  return rows.map((row) => row.table_name);
}

async function loadTableStats(client, tableName) {
  const safeTable = quoteIdentifier(tableName);
  const dateColumn = DATE_CHECKS[tableName];
  const latestExpression = dateColumn ? `max(${quoteIdentifier(dateColumn)})::text` : "null::text";
  const { rows } = await client.query(
    `select count(*)::bigint::text as count, ${latestExpression} as latest from ${safeTable}`,
  );
  return { count: rows[0].count, latest: rows[0].latest || "-" };
}

function quoteIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value.replaceAll('"', '""')}"`;
}

function loadEnv() {
  const envPath = path.resolve(__dirname, "../.env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

main().catch((error) => {
  console.error(`${error.code ? `${error.code}: ` : ""}${error.message}`);
  process.exit(1);
});
