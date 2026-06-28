#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const ROOT = path.resolve(__dirname, "..");
const KLINE_DIR = path.join(ROOT, "work/cache/eastmoney-popularity-backtest/kline");
const START_DATE = process.env.MARKET_BASELINE_START_DATE || "2025-01-01";
const UNIVERSE = process.env.MARKET_BASELINE_UNIVERSE || "local-kline-a-share";
const CHUNK_SIZE = Number(process.env.MARKET_BASELINE_CHUNK || 5000);
const HORIZONS = [
  { key: "ret5", days: 5 },
  { key: "ret10", days: 10 },
  { key: "ret20", days: 20 },
];

loadEnv();

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const universe = loadUniverse();
  if (!universe.length) throw new Error(`No local kline files found in ${KLINE_DIR}`);
  const dates = collectDates(universe).filter((date) => date >= START_DATE);
  const records = [];

  for (const date of dates) {
    for (const horizon of HORIZONS) {
      const returns = universe.map((stock) => returnAt(stock, date, horizon.days)).filter(Number.isFinite);
      const stats = summarizeReturns(returns);
      if (!stats.sample_count) continue;
      records.push({
        source: "em",
        universe: UNIVERSE,
        trade_date: date,
        horizon: horizon.key,
        ...stats,
      });
    }
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("begin");
    await upsertBaselines(client, records);
    await client.query(
      "insert into import_batches (source_file, source, strategy, row_count) values ($1, $2, $3, $4)",
      [`${KLINE_DIR} market baseline since ${START_DATE}`, "em", `market_baseline:${UNIVERSE}`, records.length],
    );
    await client.query("commit");
    console.log(`Imported ${records.length} market baseline rows from ${universe.length} stocks since ${START_DATE}`);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

function loadUniverse() {
  if (!fs.existsSync(KLINE_DIR)) return [];
  const result = [];
  for (const file of fs.readdirSync(KLINE_DIR)) {
    if (!file.endsWith(".json")) continue;
    const code = path.basename(file, ".json").split(".")[1] || "";
    if (!/^(00|30|60|68)/.test(code)) continue;
    try {
      const rows = JSON.parse(fs.readFileSync(path.join(KLINE_DIR, file), "utf8"));
      if (!Array.isArray(rows) || rows.length < 80) continue;
      const cleanRows = rows.filter((row) => row.date && Number.isFinite(row.open) && Number.isFinite(row.close));
      const indexByDate = new Map(cleanRows.map((row, index) => [row.date, index]));
      result.push({ code, rows: cleanRows, indexByDate });
    } catch {
      // Ignore malformed cache files.
    }
  }
  return result;
}

function collectDates(universe) {
  const dates = new Set();
  for (const stock of universe) {
    for (const row of stock.rows) dates.add(row.date);
  }
  return [...dates].sort();
}

function returnAt(stock, date, days) {
  const signalIndex = stock.indexByDate.get(date);
  if (!Number.isInteger(signalIndex)) return null;
  const entryIndex = signalIndex + 1;
  const exitIndex = entryIndex + days;
  const entry = stock.rows[entryIndex];
  const exit = stock.rows[exitIndex];
  if (!entry || !exit || !Number.isFinite(entry.open) || entry.open <= 0 || !Number.isFinite(exit.close)) return null;
  return (exit.close - entry.open) / entry.open;
}

function summarizeReturns(values) {
  const valid = values.filter(Number.isFinite);
  const wins = valid.filter((value) => value > 0);
  const losses = valid.filter((value) => value < 0);
  const gain = wins.reduce((sum, value) => sum + value, 0);
  const loss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const avgWin = avg(wins);
  const avgLoss = avg(losses);
  return {
    sample_count: valid.length,
    avg_return: avg(valid),
    median_return: median(valid),
    win_rate: valid.length ? wins.length / valid.length : null,
    avg_win: avgWin,
    avg_loss: avgLoss,
    payoff_ratio: avgLoss ? Math.abs((avgWin || 0) / avgLoss) : null,
    profit_factor: loss ? gain / loss : gain ? null : null,
    best_return: valid.length ? Math.max(...valid) : null,
    worst_return: valid.length ? Math.min(...valid) : null,
  };
}

function avg(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function upsertBaselines(client, records) {
  for (let index = 0; index < records.length; index += CHUNK_SIZE) {
    const chunk = records.slice(index, index + CHUNK_SIZE);
    await client.query(
      `
        with input as (
          select *
          from jsonb_to_recordset($1::jsonb) as x(
            source text,
            universe text,
            trade_date date,
            horizon text,
            sample_count integer,
            avg_return numeric,
            median_return numeric,
            win_rate numeric,
            avg_win numeric,
            avg_loss numeric,
            payoff_ratio numeric,
            profit_factor numeric,
            best_return numeric,
            worst_return numeric
          )
        )
        insert into market_daily_baselines (
          source, universe, trade_date, horizon, sample_count,
          avg_return, median_return, win_rate, avg_win, avg_loss,
          payoff_ratio, profit_factor, best_return, worst_return, updated_at
        )
        select
          source, universe, trade_date, horizon, sample_count,
          avg_return, median_return, win_rate, avg_win, avg_loss,
          payoff_ratio, profit_factor, best_return, worst_return, now()
        from input
        on conflict (source, universe, trade_date, horizon) do update set
          sample_count = excluded.sample_count,
          avg_return = excluded.avg_return,
          median_return = excluded.median_return,
          win_rate = excluded.win_rate,
          avg_win = excluded.avg_win,
          avg_loss = excluded.avg_loss,
          payoff_ratio = excluded.payoff_ratio,
          profit_factor = excluded.profit_factor,
          best_return = excluded.best_return,
          worst_return = excluded.worst_return,
          updated_at = now()
      `,
      [JSON.stringify(chunk)],
    );
  }
}

function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match) continue;
    if (process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
