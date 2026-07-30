#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { buildSslConnectionConfig } = require("../lib/postgres");

loadEnv();

async function main() {
  const connectionString = process.env.AUDIT_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("AUDIT_DATABASE_URL or DATABASE_URL is required");

  const client = new Client({
    ...buildSslConnectionConfig(
      connectionString,
      process.env.AUDIT_SSL_CA_BASE64 || process.env.DB_SSL_CA_BASE64,
    ),
    application_name: "bewin-db-audit",
    connectionTimeoutMillis: 10000,
  });

  try {
    await client.connect();

    const { rows: summaryRows } = await client.query(`
        select
          current_database() as database,
          current_setting('server_version') as server_version,
          current_setting('max_connections')::int as max_connections,
          pg_database_size(current_database())::bigint as database_bytes,
          pg_size_pretty(pg_database_size(current_database())) as database_size
      `);
    const { rows: tableRows } = await client.query(`
        select
          relname as table_name,
          n_live_tup::bigint as estimated_rows,
          pg_total_relation_size(relid)::bigint as total_bytes,
          pg_size_pretty(pg_total_relation_size(relid)) as total_size
        from pg_stat_user_tables
        order by pg_total_relation_size(relid) desc, relname
      `);
    const { rows: connectionRows } = await client.query(`
        select count(*)::int as current_connections
        from pg_stat_activity
        where datname = current_database()
      `);
    const tableNames = new Set(tableRows.map((row) => row.table_name));
    const latestDates = {
      latest_bar: await loadLatestDate(client, tableNames, "stock_daily_bars", "trade_date"),
      latest_snapshot: await loadLatestDate(client, tableNames, "popularity_snapshots", "snapshot_date"),
      latest_feature: await loadLatestDate(client, tableNames, "strategy_feature_events", "signal_date"),
      latest_signal: await loadLatestDate(client, tableNames, "strategy_signals", "signal_date"),
    };

    console.log(
      JSON.stringify(
        {
          summary: { ...summaryRows[0], ...connectionRows[0] },
          latestDates,
          tables: tableRows,
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.allSettled([client.end()]);
  }
}

async function loadLatestDate(client, tableNames, tableName, columnName) {
  if (!tableNames.has(tableName)) return null;
  const { rows } = await client.query(
    `select max(${quoteIdentifier(columnName)})::text as latest from ${quoteIdentifier(tableName)}`,
  );
  return rows[0].latest || null;
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
