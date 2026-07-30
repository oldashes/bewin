#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const zlib = require("zlib");
const { once } = require("events");
const { Pool } = require("pg");

require("../work/strategy-dashboard/server");

const ROOT = path.resolve(__dirname, "..");
const PAGE_SIZE = 3000;
const INSERT_SIZE = 2000;
const execute = process.argv.includes("--execute");
const restoreArgIndex = process.argv.indexOf("--restore");
const restoreFile = restoreArgIndex >= 0 ? process.argv[restoreArgIndex + 1] : null;

function requireDatabaseUrl() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  return process.env.DATABASE_URL;
}

function backupName() {
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  return path.join(ROOT, "backups", `popularity-snapshots-${stamp}.ndjson.gz`);
}

async function writeLine(stream, value) {
  if (!stream.write(`${JSON.stringify(value)}\n`)) await once(stream, "drain");
}

async function fileSha256(file) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(file);
  stream.on("data", (chunk) => hash.update(chunk));
  await once(stream, "end");
  return hash.digest("hex");
}

async function exportBackup(pool, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const output = fs.createWriteStream(file, { flags: "wx" });
  const gzip = zlib.createGzip({ level: 6 });
  gzip.pipe(output);

  let lastId = "0";
  let count = 0;
  try {
    while (true) {
      const { rows } = await pool.query(
        `
          select id, source, category, metric, snapshot_date::text, snapshot_key,
            snapshot_time, code, name, market, rank, rank_change, heat_value, pct,
            price, float_market_value, main_tag, raw, captured_at, updated_at
          from popularity_snapshots
          where id > $1::bigint
          order by id asc
          limit $2::int
        `,
        [lastId, PAGE_SIZE],
      );
      if (!rows.length) break;
      for (const row of rows) await writeLine(gzip, row);
      count += rows.length;
      lastId = rows.at(-1).id;
      process.stdout.write(`\rBacked up ${count} rows`);
    }
    gzip.end();
    await once(output, "finish");
  } catch (error) {
    gzip.destroy();
    output.destroy();
    throw error;
  }

  const expected = Number((await pool.query("select count(*)::int as count from popularity_snapshots")).rows[0].count);
  if (count !== expected) throw new Error(`Backup count mismatch: exported ${count}, expected ${expected}`);
  const hash = await fileSha256(file);
  fs.writeFileSync(`${file}.json`, `${JSON.stringify({ file: path.basename(file), count, lastId, sha256: hash }, null, 2)}\n`);
  process.stdout.write("\n");
  return { file, count, lastId, sha256: hash };
}

async function insertChunk(client, rows) {
  await client.query(
    `
      with input as (
        select *
        from jsonb_to_recordset($1::jsonb) as x(
          id bigint, source text, category text, metric text, snapshot_date date,
          snapshot_key text, snapshot_time timestamptz, code text, name text,
          market text, rank integer, rank_change integer, heat_value numeric,
          pct numeric, price numeric, float_market_value numeric, main_tag text,
          captured_at timestamptz, updated_at timestamptz
        )
      )
      insert into popularity_snapshots (
        id, source, category, metric, snapshot_date, snapshot_key, snapshot_time,
        code, name, market, rank, rank_change, heat_value, pct, price,
        float_market_value, main_tag, raw, captured_at, updated_at
      )
      select
        id, source, category, metric, snapshot_date, snapshot_key, snapshot_time,
        code, name, market, rank, rank_change, heat_value, pct, price,
        float_market_value, main_tag, '{}'::jsonb, captured_at, updated_at
      from input
      on conflict (source, category, metric, snapshot_key, code) do nothing
    `,
    [JSON.stringify(rows.map(({ raw: _raw, ...row }) => row))],
  );
}

async function restoreCompact(pool, file, expectedCount = null) {
  if (!file || !fs.existsSync(file)) throw new Error(`Backup file not found: ${file || "(missing)"}`);
  const client = await pool.connect();
  try {
    await client.query("truncate table popularity_snapshots restart identity");
    const input = fs.createReadStream(file).pipe(zlib.createGunzip());
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let chunk = [];
    let count = 0;
    for await (const line of lines) {
      if (!line.trim()) continue;
      chunk.push(JSON.parse(line));
      if (chunk.length < INSERT_SIZE) continue;
      await insertChunk(client, chunk);
      count += chunk.length;
      chunk = [];
      process.stdout.write(`\rRestored ${count} rows`);
    }
    if (chunk.length) {
      await insertChunk(client, chunk);
      count += chunk.length;
    }
    const actual = Number((await client.query("select count(*)::int as count from popularity_snapshots")).rows[0].count);
    if ((expectedCount !== null && actual !== expectedCount) || actual !== count) {
      throw new Error(`Restore count mismatch: read ${count}, stored ${actual}, expected ${expectedCount ?? count}`);
    }
    await client.query(
      "select setval(pg_get_serial_sequence('popularity_snapshots', 'id'), greatest(coalesce(max(id), 1), 1), true) from popularity_snapshots",
    );
    await client.query("analyze popularity_snapshots");
    process.stdout.write("\n");
    return { count: actual };
  } finally {
    client.release();
  }
}

async function relationSizes(pool) {
  const { rows } = await pool.query(
    `
      select
        pg_database_size(current_database())::bigint as database_bytes,
        pg_total_relation_size('popularity_snapshots')::bigint as snapshots_bytes
    `,
  );
  return rows[0];
}

async function main() {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  try {
    const before = await relationSizes(pool);
    if (restoreFile) {
      const restored = await restoreCompact(pool, path.resolve(restoreFile));
      console.log(JSON.stringify({ mode: "restore", before, after: await relationSizes(pool), ...restored }, null, 2));
      return;
    }

    const backup = await exportBackup(pool, backupName());
    if (!execute) {
      console.log(JSON.stringify({ mode: "backup-only", before, backup }, null, 2));
      console.log("Re-run with --execute to replace duplicated raw payloads with compact rows.");
      return;
    }

    const restored = await restoreCompact(pool, backup.file, backup.count);
    console.log(JSON.stringify({ mode: "compact", before, after: await relationSizes(pool), backup, ...restored }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
