#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const {
  bulkUpsertStrategyFeatureEvents,
  stockPreSignalMetricsFromRows,
  loadBoardKlineForDate,
  featureRecordFromDailyContext,
  readBoardCodeByName,
} = require("../work/strategy-dashboard/server");

const SOURCE = "ths";
const FEATURE_SET = "em-sector-filter-v1";
const FROM = normalizeDate(process.env.IFIND_FEATURE_FROM || process.argv[2] || "2025-09-25");
const TO = normalizeDate(process.env.IFIND_FEATURE_TO || process.argv[3] || new Date().toISOString().slice(0, 10));
const RANK_MAX = boundedInt(process.env.IFIND_FEATURE_RANK_MAX || process.argv[4], 1600, 1, 5000);
const MIN_RANK_DELTA_20 = boundedNumber(process.env.IFIND_FEATURE_MIN_RANK_DELTA_20, 0, -5000, 5000);
const AMOUNT_RATIO_MIN = boundedNumber(process.env.IFIND_FEATURE_AMOUNT_RATIO_MIN, 0.8, 0, 100);
const AMOUNT_RATIO_MAX = boundedNumber(process.env.IFIND_FEATURE_AMOUNT_RATIO_MAX, 3.2, 0, 100);
const PREV5_MIN = boundedNumber(process.env.IFIND_FEATURE_PREV5_MIN_PCT, -15, -100, 1000) / 100;
const PREV5_MAX = boundedNumber(process.env.IFIND_FEATURE_PREV5_MAX_PCT, 35, -100, 1000) / 100;
const LIMIT_DATES = boundedInt(process.env.IFIND_FEATURE_LIMIT_DATES, 0, 0, 10000);
const SAVE_CHUNK_SIZE = boundedInt(process.env.IFIND_FEATURE_SAVE_CHUNK_SIZE, 5000, 100, 20000);
const SKIP_BOARD = ["1", "true", "yes"].includes(String(process.env.IFIND_FEATURE_SKIP_BOARD || "").toLowerCase());
const BOARD_MODE = String(process.env.IFIND_FEATURE_BOARD_MODE || "cached").toLowerCase();
const DRY_RUN = ["1", "true", "yes"].includes(String(process.env.IFIND_FEATURE_DRY_RUN || "").toLowerCase());
const KLINE_DIR = path.join(__dirname, "..", "work", "cache", "eastmoney-popularity-backtest", "kline");

if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL in .env or environment.");
  process.exit(1);
}

if (!FROM || !TO || FROM > TO) {
  console.error("Invalid date range. Use IFIND_FEATURE_FROM=YYYY-MM-DD IFIND_FEATURE_TO=YYYY-MM-DD.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });

async function main() {
  const startedAt = new Date().toISOString();
  const snapshots = await loadSnapshots();
  const dates = [...new Set(snapshots.map((row) => row.date))].sort();
  const selectedDates = LIMIT_DATES ? dates.slice(-LIMIT_DATES) : dates;
  const selectedDateSet = new Set(selectedDates);
  const selectedSnapshots = snapshots.filter((row) => selectedDateSet.has(row.date));
  const codes = [...new Set(snapshots.map((row) => row.code))];
  const [klineByCode, donorByKey] = await Promise.all([loadKlines(codes), loadEmDonors(codes)]);
  const historyByCode = buildRankHistory(snapshots);
  const boardCodeByName = readBoardCodeByName();
  const boardRowsByCode = new Map();
  const boardMetricsByKey = new Map();
  const stats = {
    source: SOURCE,
    featureSet: FEATURE_SET,
    from: FROM,
    to: TO,
    rankMax: RANK_MAX,
    minRankDelta20: MIN_RANK_DELTA_20,
    amountRatioMin: AMOUNT_RATIO_MIN,
    amountRatioMax: AMOUNT_RATIO_MAX,
    prev5Min: PREV5_MIN,
    prev5Max: PREV5_MAX,
    dryRun: DRY_RUN,
    skipBoard: SKIP_BOARD,
    boardMode: BOARD_MODE,
    loadedSnapshots: snapshots.length,
    selectedDates: selectedDates.length,
    selectedSnapshots: selectedSnapshots.length,
    savedRecords: 0,
    generatedRecords: 0,
    skippedMissingRank20: 0,
    skippedMissingStockKline: 0,
    skippedMissingStockMetrics: 0,
    skippedMissingRank: 0,
    boardDonorCount: 0,
    boardComputedCount: 0,
    boardMissingCount: 0,
    startedAt,
    finishedAt: null,
  };

  const pending = [];
  for (const row of selectedSnapshots) {
    const history = historyByCode.get(row.code) || [];
    const rank20 = rankAtOffset(history, row.date, 20);
    if (!Number.isFinite(rank20)) {
      stats.skippedMissingRank20 += 1;
      continue;
    }
    if (rank20 - row.rank < MIN_RANK_DELTA_20) continue;

    const stockRows = klineByCode.get(row.code);
    if (!stockRows?.length) {
      stats.skippedMissingStockKline += 1;
      continue;
    }
    const stockMetrics = stockPreSignalMetricsFromRows(stockRows, row.date);
    if (
      !Number.isFinite(stockMetrics.prev5) ||
      !Number.isFinite(stockMetrics.amountRatio) ||
      !Number.isFinite(stockMetrics.signalClose)
    ) {
      stats.skippedMissingStockMetrics += 1;
      continue;
    }
    if (
      stockMetrics.amountRatio < AMOUNT_RATIO_MIN ||
      stockMetrics.amountRatio > AMOUNT_RATIO_MAX ||
      stockMetrics.prev5 < PREV5_MIN ||
      stockMetrics.prev5 > PREV5_MAX
    ) {
      continue;
    }

    const donor = donorByKey.get(`${row.date}:${row.code}`) || null;
    const item = itemFromSnapshot(row, donor, boardCodeByName);
    let boardMetrics = boardMetricsFromDonor(donor);
    if (boardMetrics) {
      stats.boardDonorCount += 1;
    } else if (!SKIP_BOARD && item.bestBoardCode) {
      boardMetrics = await getBoardMetrics(item.bestBoardCode, row.date, boardRowsByCode, boardMetricsByKey);
      if (boardMetrics) stats.boardComputedCount += 1;
      else stats.boardMissingCount += 1;
    } else {
      stats.boardMissingCount += 1;
    }

    const feature = featureRecordFromDailyContext({
      sourceKey: SOURCE,
      targetDate: row.date,
      item,
      history,
      stockMetrics,
      boardMetrics,
    });
    if (!feature) {
      stats.skippedMissingRank += 1;
      continue;
    }
    feature.raw = {
      ...(feature.raw || {}),
      generator: "ifind-ths-feature-backfill",
      generatedAt: new Date().toISOString(),
      provider: "ifind",
      snapshotKey: row.snapshot_key,
      donorBoard: Boolean(donor && boardMetrics),
      boardMetricsAvailable: Boolean(boardMetrics),
    };
    pending.push(feature);
    stats.generatedRecords += 1;

    if (pending.length >= SAVE_CHUNK_SIZE) {
      stats.savedRecords += await saveFeatures(pending.splice(0, pending.length));
      console.log(`generated=${stats.generatedRecords} saved=${stats.savedRecords}`);
    }
  }

  stats.savedRecords += await saveFeatures(pending);
  stats.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(stats, null, 2));
}

async function loadSnapshots() {
  const { rows } = await pool.query(
    `
      select
        p.snapshot_date::text as date,
        p.snapshot_key,
        p.code,
        coalesce(nullif(trim(s.name), ''), nullif(trim(p.name), ''), p.code) as name,
        p.rank::int as rank,
        s.exchange,
        s.board,
        s.industry,
        s.region,
        s.concepts,
        s.listing_date::text as listing_date
      from popularity_snapshots p
      left join stocks s on s.code = p.code
      where p.source = 'ths'
        and p.category = 'stock'
        and p.metric = 'hot'
        and p.snapshot_key like '%ifind%'
        and p.snapshot_date between $1::date and $2::date
        and p.rank between 1 and $3
      order by p.snapshot_date asc, p.rank asc
    `,
    [FROM, TO, RANK_MAX],
  );
  return rows.map((row) => ({
    ...row,
    code: String(row.code || "").match(/\d{6}/)?.[0] || "",
    rank: Number(row.rank),
    concepts: normalizeConcepts(row.concepts),
  })).filter((row) => row.code && row.date && Number.isFinite(row.rank));
}

async function loadKlines(codes) {
  if (!codes.length) return new Map();
  const { rows } = await pool.query(
    `
      select code, trade_date::text as trade_date, open, close, high, low, volume, amount, turnover, pct
      from stock_daily_bars
      where code = any($1)
        and trade_date between ($2::date - interval '140 days') and $3::date
      order by code asc, trade_date asc
    `,
    [codes, FROM, TO],
  );
  const byCode = new Map();
  for (const row of rows) {
    const code = String(row.code || "");
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push({
      date: normalizeDate(row.trade_date),
      open: n(row.open),
      close: n(row.close),
      high: n(row.high),
      low: n(row.low),
      volume: n(row.volume),
      amount: n(row.amount),
      turnover: n(row.turnover),
      pct: n(row.pct),
    });
  }
  return byCode;
}

async function loadEmDonors(codes) {
  if (!codes.length) return new Map();
  const { rows } = await pool.query(
    `
      select
        signal_date::text as signal_date,
        code,
        best_board_type,
        best_board_code,
        best_board_name,
        best_board_ret_5,
        best_board_ret_10,
        best_board_amount_ratio,
        has_strong_board,
        has_strong_industry,
        has_strong_concept
      from strategy_feature_events
      where source = 'em'
        and feature_set = $1
        and code = any($2)
        and signal_date between $3::date and $4::date
    `,
    [FEATURE_SET, codes, FROM, TO],
  );
  const byKey = new Map();
  for (const row of rows) byKey.set(`${normalizeDate(row.signal_date)}:${row.code}`, row);
  return byKey;
}

function buildRankHistory(rows) {
  const byCode = new Map();
  for (const row of rows) {
    if (!byCode.has(row.code)) byCode.set(row.code, []);
    byCode.get(row.code).push({ date: row.date, rank: row.rank });
  }
  for (const items of byCode.values()) items.sort((a, b) => a.date.localeCompare(b.date));
  return byCode;
}

function rankAtOffset(history, targetDate, offset) {
  const rows = (history || []).filter((item) => item.date <= targetDate && Number.isFinite(item.rank));
  if (!rows.length) return null;
  return rows[Math.max(0, rows.length - 1 - offset)]?.rank ?? null;
}

function itemFromSnapshot(row, donor, boardCodeByName) {
  const fallbackBoardName = row.industry || row.concepts?.[0] || row.board || "";
  const bestBoardName = donor?.best_board_name || fallbackBoardName;
  const bestBoardType = donor?.best_board_type || (row.industry && bestBoardName === row.industry ? "industry" : bestBoardName ? "concept" : "");
  return {
    code: row.code,
    name: row.name || row.code,
    industry: row.industry || "",
    board: row.board || "",
    concepts: row.concepts || [],
    bestBoardName,
    bestBoardType,
    bestBoardCode: donor?.best_board_code || boardCodeByName.get(bestBoardName) || "",
    source: "ifind",
  };
}

function boardMetricsFromDonor(row) {
  if (!row) return null;
  const prev5 = n(row.best_board_ret_5);
  const amountRatio = n(row.best_board_amount_ratio);
  if (!Number.isFinite(prev5) || !Number.isFinite(amountRatio)) return null;
  return {
    prev5,
    prev10: n(row.best_board_ret_10),
    amountRatio,
  };
}

async function getBoardMetrics(boardCode, date, rowsByCode, metricsByKey) {
  const key = `${boardCode}:${date}`;
  if (metricsByKey.has(key)) return metricsByKey.get(key);
  if (!rowsByCode.has(boardCode)) {
    rowsByCode.set(boardCode, await loadBoardRows(boardCode, date));
  }
  const rows = rowsByCode.get(boardCode) || [];
  const metrics = stockPreSignalMetricsFromRows(rows, date);
  const value =
    Number.isFinite(metrics.prev5) && Number.isFinite(metrics.amountRatio)
      ? metrics
      : null;
  metricsByKey.set(key, value);
  return value;
}

async function loadBoardRows(boardCode, date) {
  const cachedRows = readCachedBoardRows(boardCode, date);
  if (cachedRows.length || BOARD_MODE === "cached") return cachedRows;
  if (BOARD_MODE === "none") return [];
  try {
    return await loadBoardKlineForDate(boardCode, date);
  } catch {
    return [];
  }
}

function readCachedBoardRows(boardCode, date) {
  const code = String(boardCode || "").trim().toUpperCase();
  if (!/^BK\d{4}$/.test(code)) return [];
  const file = path.join(KLINE_DIR, `90.${code}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(rows) || !rows.some((row) => row.date === date)) return [];
    return rows;
  } catch {
    return [];
  }
}

async function saveFeatures(records) {
  if (!records.length) return 0;
  if (DRY_RUN) return records.length;
  return bulkUpsertStrategyFeatureEvents(records);
}

function normalizeConcepts(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value) return [];
  if (typeof value === "object") return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // Fall through to delimiter parsing.
  }
  return String(value)
    .split(/[,\s，、]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value || "").trim().replaceAll("/", "-");
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function n(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
