#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const ROOT = path.resolve(__dirname, "..");
const KLINE_DIR = path.join(ROOT, "work/cache/eastmoney-popularity-backtest/kline");
const BOARD_MEMBER_DIR = path.join(ROOT, "work/cache/sector-filter-backtest/board-members");
const FEATURE_IMPORTS = [
  {
    file: "outputs/em-popularity-sector-filter-all-enriched.csv",
    source: "em",
    featureSet: "em-sector-filter-v1",
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
    const klineByCode = loadKlineByCode(KLINE_DIR);
    const boardContext = createBoardContext(loadBoardMembers(BOARD_MEMBER_DIR), klineByCode);
    for (const item of FEATURE_IMPORTS) {
      const fullPath = path.join(ROOT, item.file);
      if (!fs.existsSync(fullPath)) {
        console.log(`Skip missing file: ${item.file}`);
        continue;
      }
      const rows = parseCsv(fs.readFileSync(fullPath, "utf8"));
      const count = await importFeatureRows(client, item, rows, stockMeta, boardContext);
      console.log(`Imported ${count} feature rows from ${item.file}`);
    }
  } finally {
    await client.end();
  }
}

async function importFeatureRows(client, item, rows, stockMeta, boardContext) {
  const stockRecordsByCode = new Map();
  const featureRecords = [];

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

    const rank = int(row.rank);
    const rank20 = int(row.rank20);
    const boardStats = attachBoardContext(row, signalDate, boardContext);
    featureRecords.push({
      source: item.source,
      feature_set: item.featureSet,
      signal_date: signalDate,
      code,
      name,
      rank,
      rank_5: int(row.rank5),
      rank_10: int(row.rank10),
      rank_20: rank20,
      rank_delta_20: rank && rank20 ? rank20 - rank : null,
      median_5: num(row.median5),
      median_prev_5: num(row.medianPrev5),
      median_prev_10: num(row.medianPrev10),
      prev_5: num(row.prev5 || row.stockPrev5),
      prev_10: num(row.prev10 || row.stockPrev10),
      amount_ratio: num(row.amountRatio || row.volumeRatio || row.stockAmountRatio),
      turnover_5: num(row.turnover5),
      entry_date: date(row.entryDate),
      entry_open: num(row.entryOpen),
      signal_close: num(row.signalClose),
      ret_5: num(row.ret5),
      ret_10: num(row.ret10),
      ret_20: num(row.ret20),
      board_count: int(row.boardCount),
      has_strong_board: bool(row.hasStrongBoard),
      has_strong_industry: bool(row.hasStrongIndustry),
      has_strong_concept: bool(row.hasStrongConcept),
      best_board_type: text(row.bestBoardType || row.boardType),
      best_board_code: text(row.bestBoardCode || row.boardCode),
      best_board_name: text(row.bestBoardName || row.boardName),
      best_board_ret_5: num(row.bestBoardRet5 || row.boardRet5),
      best_board_ret_10: num(row.bestBoardRet10 || row.boardRet10),
      best_board_amount_ratio: num(row.bestBoardAmountRatio || row.boardAmountRatio),
      best_board_score_rank_pct: num(row.bestBoardScoreRankPct || row.boardScoreRankPct),
      score: num(row.score || row.finalScore || row.modelScore),
      raw: { ...row, ...boardStats },
    });
  }

  await client.query("begin");
  try {
    await bulkUpsertStocks(client, Array.from(stockRecordsByCode.values()));
    await bulkUpsertFeatures(client, featureRecords);
    await client.query(
      "insert into import_batches (source_file, source, strategy, row_count) values ($1, $2, $3, $4)",
      [item.file, item.source, `features:${item.featureSet}`, featureRecords.length],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }

  return featureRecords.length;
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

async function bulkUpsertFeatures(client, records) {
  if (!records.length) return;
  for (let index = 0; index < records.length; index += 5000) {
    const chunk = records.slice(index, index + 5000);
    await client.query(
      `
        with input as (
          select *
          from jsonb_to_recordset($1::jsonb) as x(
            source text,
            feature_set text,
            signal_date date,
            code text,
            name text,
            rank integer,
            rank_5 integer,
            rank_10 integer,
            rank_20 integer,
            rank_delta_20 integer,
            median_5 numeric,
            median_prev_5 numeric,
            median_prev_10 numeric,
            prev_5 numeric,
            prev_10 numeric,
            amount_ratio numeric,
            turnover_5 numeric,
            entry_date date,
            entry_open numeric,
            signal_close numeric,
            ret_5 numeric,
            ret_10 numeric,
            ret_20 numeric,
            board_count integer,
            has_strong_board boolean,
            has_strong_industry boolean,
            has_strong_concept boolean,
            best_board_type text,
            best_board_code text,
            best_board_name text,
            best_board_ret_5 numeric,
            best_board_ret_10 numeric,
            best_board_amount_ratio numeric,
            best_board_score_rank_pct numeric,
            score numeric,
            raw jsonb
          )
        )
        insert into strategy_feature_events (
          source, feature_set, signal_date, code, name,
          rank, rank_5, rank_10, rank_20, rank_delta_20,
          median_5, median_prev_5, median_prev_10,
          prev_5, prev_10, amount_ratio, turnover_5,
          entry_date, entry_open, signal_close,
          ret_5, ret_10, ret_20,
          board_count, has_strong_board, has_strong_industry, has_strong_concept,
          best_board_type, best_board_code, best_board_name,
          best_board_ret_5, best_board_ret_10, best_board_amount_ratio, best_board_score_rank_pct,
          score, raw, updated_at
        )
        select
          source, feature_set, signal_date, code, name,
          rank, rank_5, rank_10, rank_20, rank_delta_20,
          median_5, median_prev_5, median_prev_10,
          prev_5, prev_10, amount_ratio, turnover_5,
          entry_date, entry_open, signal_close,
          ret_5, ret_10, ret_20,
          board_count, has_strong_board, has_strong_industry, has_strong_concept,
          best_board_type, best_board_code, best_board_name,
          best_board_ret_5, best_board_ret_10, best_board_amount_ratio, best_board_score_rank_pct,
          score, coalesce(raw, '{}'::jsonb), now()
        from input
        on conflict (source, feature_set, signal_date, code) do update set
          name = excluded.name,
          rank = excluded.rank,
          rank_5 = excluded.rank_5,
          rank_10 = excluded.rank_10,
          rank_20 = excluded.rank_20,
          rank_delta_20 = excluded.rank_delta_20,
          median_5 = excluded.median_5,
          median_prev_5 = excluded.median_prev_5,
          median_prev_10 = excluded.median_prev_10,
          prev_5 = excluded.prev_5,
          prev_10 = excluded.prev_10,
          amount_ratio = excluded.amount_ratio,
          turnover_5 = excluded.turnover_5,
          entry_date = excluded.entry_date,
          entry_open = excluded.entry_open,
          signal_close = excluded.signal_close,
          ret_5 = excluded.ret_5,
          ret_10 = excluded.ret_10,
          ret_20 = excluded.ret_20,
          board_count = excluded.board_count,
          has_strong_board = excluded.has_strong_board,
          has_strong_industry = excluded.has_strong_industry,
          has_strong_concept = excluded.has_strong_concept,
          best_board_type = excluded.best_board_type,
          best_board_code = excluded.best_board_code,
          best_board_name = excluded.best_board_name,
          best_board_ret_5 = excluded.best_board_ret_5,
          best_board_ret_10 = excluded.best_board_ret_10,
          best_board_amount_ratio = excluded.best_board_amount_ratio,
          best_board_score_rank_pct = excluded.best_board_score_rank_pct,
          score = excluded.score,
          raw = excluded.raw,
          updated_at = now()
      `,
      [JSON.stringify(chunk)],
    );
  }
}

function readStockMeta() {
  const file = path.join(ROOT, "work/cache/strategy-dashboard/stock-meta.json");
  if (!fs.existsSync(file)) return new Map();
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  return new Map(Object.entries(json.byCode || {}));
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
    if (process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

function text(value) {
  const raw = String(value ?? "").trim();
  return raw || null;
}

function int(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function num(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function date(value) {
  const raw = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return null;
}

function bool(value) {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return null;
}

function loadKlineByCode(dir) {
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const code = path.basename(file, ".json").split(".")[1] || "";
    if (!/^(00|30|60|68)/.test(code)) continue;
    try {
      const rows = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (!Array.isArray(rows) || rows.length < 40) continue;
      map.set(
        code,
        rows.filter((row) => row.date && Number.isFinite(row.open) && Number.isFinite(row.close)),
      );
    } catch {
      // Ignore malformed cache files.
    }
  }
  return map;
}

function loadBoardMembers(dir) {
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const boardCode = path.basename(file, ".json");
    try {
      const members = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (!Array.isArray(members)) continue;
      map.set(
        boardCode,
        members
          .map((member) => String(member.code || "").match(/\d{6}/)?.[0] || "")
          .filter((code) => /^(00|30|60|68)/.test(code)),
      );
    } catch {
      // Ignore malformed board cache files.
    }
  }
  return map;
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function median(values) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

function stockPrevReturn(rows, signalDate, days = 5) {
  if (!Array.isArray(rows) || !signalDate) return null;
  let index = rows.findIndex((row) => row.date === signalDate);
  if (index < 0) index = rows.findIndex((row) => row.date > signalDate);
  if (index < days || index < 0) return null;
  const current = rows[index];
  const before = rows[index - days];
  if (!current || !before || !Number.isFinite(current.close) || !Number.isFinite(before.close) || before.close <= 0) {
    return null;
  }
  return (current.close - before.close) / before.close;
}

function emptyBoardStats() {
  return {
    boardMemberCount: null,
    boardValidMemberCount: null,
    boardPositiveRatio: null,
    boardHotRatio: null,
    boardStrongRatio: null,
    boardMemberAvgRet5: null,
    boardMemberMedianRet5: null,
    memberReturns: [],
  };
}

function createBoardContext(boardMembers, klineByCode) {
  const cache = new Map();
  return {
    stats(boardCode, signalDate) {
      if (!boardCode || !signalDate) return emptyBoardStats();
      const key = `${boardCode}:${signalDate}`;
      if (cache.has(key)) return cache.get(key);
      const members = boardMembers.get(boardCode) || [];
      const returns = members
        .map((code) => ({ code, ret5: stockPrevReturn(klineByCode.get(code), signalDate, 5) }))
        .filter((item) => Number.isFinite(item.ret5));
      const values = returns.map((item) => item.ret5);
      const stats = {
        boardMemberCount: members.length,
        boardValidMemberCount: returns.length,
        boardPositiveRatio: values.length ? values.filter((value) => value > 0).length / values.length : null,
        boardHotRatio: values.length ? values.filter((value) => value >= 0.03).length / values.length : null,
        boardStrongRatio: values.length ? values.filter((value) => value >= 0.08).length / values.length : null,
        boardMemberAvgRet5: average(values),
        boardMemberMedianRet5: median(values),
        memberReturns: returns,
      };
      cache.set(key, stats);
      return stats;
    },
  };
}

function attachBoardContext(row, signalDate, boardContext) {
  const stats = boardContext.stats(text(row.bestBoardCode || row.boardCode), signalDate);
  const memberReturns = stats.memberReturns || [];
  const candidateRet = num(row.prev5 || row.stockPrev5);
  let boardLeaderPct = null;
  let boardLeaderRank = null;
  if (Number.isFinite(candidateRet) && memberReturns.length) {
    const sorted = memberReturns.map((item) => item.ret5).sort((a, b) => b - a);
    const betterCount = sorted.filter((value) => value > candidateRet).length;
    boardLeaderRank = betterCount + 1;
    boardLeaderPct = boardLeaderRank / sorted.length;
  }
  return {
    boardMemberCount: stats.boardMemberCount,
    boardValidMemberCount: stats.boardValidMemberCount,
    boardPositiveRatio: stats.boardPositiveRatio,
    boardHotRatio: stats.boardHotRatio,
    boardStrongRatio: stats.boardStrongRatio,
    boardMemberAvgRet5: stats.boardMemberAvgRet5,
    boardMemberMedianRet5: stats.boardMemberMedianRet5,
    boardLeaderRank,
    boardLeaderPct,
    boardMemberExcessRet5:
      Number.isFinite(candidateRet) && Number.isFinite(stats.boardMemberMedianRet5) ? candidateRet - stats.boardMemberMedianRet5 : null,
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
