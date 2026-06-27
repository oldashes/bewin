#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const ROOT = path.resolve(__dirname, "..");
const KLINE_DIR = path.join(ROOT, "work/cache/eastmoney-popularity-backtest/kline");
const START_DATE = process.env.KLINE_START_DATE || "2024-01-01";
const CHUNK_SIZE = Number(process.env.KLINE_IMPORT_CHUNK || 5000);

loadEnv();

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const codes = await signalCodes(client);
    let totalRows = 0;
    let importedStocks = 0;

    for (const code of codes) {
      const rows = readKlineRows(code).filter((row) => row.date >= START_DATE);
      if (!rows.length) continue;
      await importBars(client, code, rows);
      totalRows += rows.length;
      importedStocks += 1;
      if (importedStocks % 50 === 0) {
        console.log(`Imported ${importedStocks}/${codes.length} stocks, ${totalRows} bars`);
      }
    }

    await client.query(
      "insert into import_batches (source_file, source, strategy, row_count) values ($1, $2, $3, $4)",
      [`${KLINE_DIR} since ${START_DATE}`, "em", "daily_bars", totalRows],
    );
    console.log(`Imported ${totalRows} daily bars for ${importedStocks} stocks since ${START_DATE}`);
  } finally {
    await client.end();
  }
}

async function signalCodes(client) {
  const { rows } = await client.query("select distinct code from strategy_signals order by code");
  return rows.map((row) => row.code).filter(Boolean);
}

function readKlineRows(code) {
  const marketId = /^(6|9)/.test(code) ? "1" : "0";
  const file = path.join(KLINE_DIR, `${marketId}.${code}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(rows) ? rows.filter((row) => row.date && Number.isFinite(row.open) && Number.isFinite(row.close)) : [];
  } catch {
    return [];
  }
}

async function importBars(client, code, rows) {
  for (let index = 0; index < rows.length; index += CHUNK_SIZE) {
    const chunk = rows.slice(index, index + CHUNK_SIZE).map((row) => ({
      code,
      trade_date: row.date,
      market: /^(6|9)/.test(code) ? "SH" : "SZ",
      open: numberOrNull(row.open),
      close: numberOrNull(row.close),
      high: numberOrNull(row.high),
      low: numberOrNull(row.low),
      volume: numberOrNull(row.volume),
      amount: numberOrNull(row.amount),
      amplitude: numberOrNull(row.amplitude),
      pct: numberOrNull(row.pct),
      change: numberOrNull(row.change),
      turnover: numberOrNull(row.turnover),
    }));
    await client.query(
      `
        with input as (
          select *
          from jsonb_to_recordset($1::jsonb) as x(
            code text,
            trade_date date,
            market text,
            open numeric,
            close numeric,
            high numeric,
            low numeric,
            volume numeric,
            amount numeric,
            amplitude numeric,
            pct numeric,
            change numeric,
            turnover numeric
          )
        )
        insert into stock_daily_bars (
          code, trade_date, market, open, close, high, low, volume, amount,
          amplitude, pct, change, turnover, source, updated_at
        )
        select
          code, trade_date, market, open, close, high, low, volume, amount,
          amplitude, pct, change, turnover, 'eastmoney', now()
        from input
        on conflict (code, trade_date) do update set
          market = excluded.market,
          open = excluded.open,
          close = excluded.close,
          high = excluded.high,
          low = excluded.low,
          volume = excluded.volume,
          amount = excluded.amount,
          amplitude = excluded.amplitude,
          pct = excluded.pct,
          change = excluded.change,
          turnover = excluded.turnover,
          source = excluded.source,
          updated_at = now()
      `,
      [JSON.stringify(chunk)],
    );
  }
}

function numberOrNull(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function loadEnv() {
  const envPath = path.join(ROOT, ".env");
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
  console.error(error);
  process.exit(1);
});
