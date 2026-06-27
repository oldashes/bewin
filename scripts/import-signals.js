#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const ROOT = path.resolve(__dirname, "..");
const IMPORTS = [
  {
    file: "outputs/em-popularity-sector-filter-sweet-spot-events.csv",
    source: "em",
    strategy: "early",
  },
  {
    file: "outputs/latest-one-month-strategy-candidates.csv",
    source: "em",
    strategy: "early",
  },
  {
    file: "outputs/em-popularity-backtest-events.csv",
    source: "em",
    strategy: "hot",
  },
];

loadEnv();

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const stockMeta = readStockMeta();
    for (const item of IMPORTS) {
      const fullPath = path.join(ROOT, item.file);
      if (!fs.existsSync(fullPath)) {
        console.log(`Skip missing file: ${item.file}`);
        continue;
      }
      const rows = parseCsv(fs.readFileSync(fullPath, "utf8"));
      await importRows(client, item, rows, stockMeta);
      console.log(`Imported ${rows.length} rows from ${item.file}`);
    }
  } finally {
    await client.end();
  }
}

async function importRows(client, item, rows, stockMeta) {
  const stockRecordsByCode = new Map();
  const signalRecords = [];

  for (const row of rows) {
    const code = text(row.code);
    const signalDate = date(row.signalDate);
    if (!code || !signalDate) continue;
    const meta = stockMeta.get(code) || {};
    const name = text(row.name) || meta.name || code;
    stockRecordsByCode.set(code, {
      code,
      name,
      exchange: text(meta.exchange),
      board: text(meta.board),
      industry: text(meta.industry),
      region: text(meta.region),
      concepts: Array.isArray(meta.concepts) ? meta.concepts : [],
      listing_date: date(meta.listingDate || meta.listing_date),
    });

    const source = item.source;
    const strategy = item.strategy;
    const rank = int(row.rank);
    const rank20 = int(row.rank20);
    const metrics = {
      median5: num(row.median5),
      medianPrev5: num(row.medianPrev5),
      medianPrev10: num(row.medianPrev10),
      trendScore: num(row.trendScore),
      hotScore: num(row.hotScore),
      signalAmount: num(row.signalAmount),
      signalTurnover: num(row.signalTurnover),
      amount5: num(row.amount5),
      amount20: num(row.amount20),
      volumeRatio: num(row.volumeRatio),
      totalMarketValue: num(row.totalMarketValue),
      floatMarketValue: num(row.floatMarketValue),
      boardCount: int(row.boardCount),
      hasStrongBoard: bool(row.hasStrongBoard),
      hasStrongIndustry: bool(row.hasStrongIndustry),
      hasStrongConcept: bool(row.hasStrongConcept),
      bestBoardRet10: num(row.bestBoardRet10),
      bestBoardScoreRankPct: num(row.bestBoardScoreRankPct),
    };

    signalRecords.push({
      source,
      strategy,
      signal_date: signalDate,
      code,
      name,
      rank,
      rank_5: int(row.rank5),
      rank_10: int(row.rank10),
      rank_20: rank20,
      rank_delta_20: rank && rank20 ? rank20 - rank : null,
      score: num(row.score),
      model_score: num(row.modelScore || row.finalScore),
      amount_ratio: num(row.amountRatio || row.volumeRatio || row.stockAmountRatio),
      turnover_5: num(row.turnover5),
      entry_date: date(row.entryDate),
      entry_open: num(row.entryOpen),
      signal_close: num(row.signalClose),
      ret_5: num(row.ret5),
      ret_10: num(row.ret10),
      ret_20: num(row.ret20),
      best_board_type: text(row.bestBoardType || row.boardType),
      best_board_code: text(row.bestBoardCode || row.boardCode),
      best_board_name: text(row.bestBoardName || row.boardName),
      best_board_ret_5: num(row.bestBoardRet5 || row.boardRet5),
      best_board_amount_ratio: num(row.bestBoardAmountRatio || row.boardAmountRatio),
      metrics: cleanObject(metrics),
      raw: row,
    });
  }

  await client.query("begin");
  try {
    await bulkUpsertStocks(client, Array.from(stockRecordsByCode.values()));
    await bulkUpsertSignals(client, signalRecords);

    await client.query(
      "insert into import_batches (source_file, source, strategy, row_count) values ($1, $2, $3, $4)",
      [item.file, item.source, item.strategy, signalRecords.length],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function bulkUpsertStocks(client, records) {
  if (!records.length) return;
  await client.query(
    `
      with input as (
        select *
        from jsonb_to_recordset($1::jsonb) as x(
          code text,
          name text,
          exchange text,
          board text,
          industry text,
          region text,
          concepts jsonb,
          listing_date date
        )
      )
      insert into stocks (code, name, exchange, board, industry, region, concepts, listing_date, updated_at)
      select code, name, exchange, board, industry, region, coalesce(concepts, '[]'::jsonb), listing_date, now()
      from input
      on conflict (code) do update set
        name = coalesce(excluded.name, stocks.name),
        exchange = coalesce(excluded.exchange, stocks.exchange),
        board = coalesce(excluded.board, stocks.board),
        industry = coalesce(excluded.industry, stocks.industry),
        region = coalesce(excluded.region, stocks.region),
        concepts = excluded.concepts,
        listing_date = coalesce(excluded.listing_date, stocks.listing_date),
        updated_at = now()
    `,
    [JSON.stringify(records)],
  );
}

async function bulkUpsertSignals(client, records) {
  if (!records.length) return;
  await client.query(
    `
      with input as (
        select *
        from jsonb_to_recordset($1::jsonb) as x(
          source text,
          strategy text,
          signal_date date,
          code text,
          name text,
          rank integer,
          rank_5 integer,
          rank_10 integer,
          rank_20 integer,
          rank_delta_20 integer,
          score numeric,
          model_score numeric,
          amount_ratio numeric,
          turnover_5 numeric,
          entry_date date,
          entry_open numeric,
          signal_close numeric,
          ret_5 numeric,
          ret_10 numeric,
          ret_20 numeric,
          best_board_type text,
          best_board_code text,
          best_board_name text,
          best_board_ret_5 numeric,
          best_board_amount_ratio numeric,
          metrics jsonb,
          raw jsonb
        )
      )
      insert into strategy_signals (
        source, strategy, signal_date, code, name,
        rank, rank_5, rank_10, rank_20, rank_delta_20,
        score, model_score, amount_ratio, turnover_5,
        entry_date, entry_open, signal_close,
        ret_5, ret_10, ret_20,
        best_board_type, best_board_code, best_board_name, best_board_ret_5, best_board_amount_ratio,
        metrics, raw, updated_at
      )
      select
        source, strategy, signal_date, code, name,
        rank, rank_5, rank_10, rank_20, rank_delta_20,
        score, model_score, amount_ratio, turnover_5,
        entry_date, entry_open, signal_close,
        ret_5, ret_10, ret_20,
        best_board_type, best_board_code, best_board_name, best_board_ret_5, best_board_amount_ratio,
        coalesce(metrics, '{}'::jsonb), coalesce(raw, '{}'::jsonb), now()
      from input
      on conflict (source, strategy, signal_date, code) do update set
        name = excluded.name,
        rank = excluded.rank,
        rank_5 = excluded.rank_5,
        rank_10 = excluded.rank_10,
        rank_20 = excluded.rank_20,
        rank_delta_20 = excluded.rank_delta_20,
        score = excluded.score,
        model_score = excluded.model_score,
        amount_ratio = excluded.amount_ratio,
        turnover_5 = excluded.turnover_5,
        entry_date = excluded.entry_date,
        entry_open = excluded.entry_open,
        signal_close = excluded.signal_close,
        ret_5 = excluded.ret_5,
        ret_10 = excluded.ret_10,
        ret_20 = excluded.ret_20,
        best_board_type = excluded.best_board_type,
        best_board_code = excluded.best_board_code,
        best_board_name = excluded.best_board_name,
        best_board_ret_5 = excluded.best_board_ret_5,
        best_board_amount_ratio = excluded.best_board_amount_ratio,
        metrics = excluded.metrics,
        raw = excluded.raw,
        updated_at = now()
    `,
    [JSON.stringify(records)],
  );
}

function readStockMeta() {
  const file = path.join(ROOT, "work/cache/strategy-dashboard/stock-meta.json");
  if (!fs.existsSync(file)) return new Map();
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const byCode = json.byCode || {};
  return new Map(Object.entries(byCode));
}

function parseCsv(textValue) {
  const lines = textValue.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map((header) => header.replace(/^\ufeff/, ""));
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
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

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== ""));
}

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function num(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function int(value) {
  const result = Number.parseInt(value, 10);
  return Number.isFinite(result) ? result : null;
}

function date(value) {
  const result = text(value);
  return result && /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : null;
}

function bool(value) {
  const result = text(value);
  if (result === null) return null;
  if (/^(true|1|yes)$/i.test(result)) return true;
  if (/^(false|0|no)$/i.test(result)) return false;
  return null;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
