#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const path = require("path");
const { Pool } = require("pg");

const ROOT = path.resolve(__dirname, "../..");
loadEnvFile(path.join(ROOT, ".env"));
const PUBLIC_DIR = path.join(ROOT, "public");
const EVENTS_FILE = path.join(ROOT, "outputs/em-popularity-sector-filter-sweet-spot-events.csv");
const HOT_EVENTS_FILE = path.join(ROOT, "outputs/em-popularity-backtest-events.csv");
const RECENT_CANDIDATES_FILE = path.join(ROOT, "outputs/latest-one-month-strategy-candidates.csv");
const THS_CANDIDATES_FILE = path.join(ROOT, "outputs/ths-popularity-strategy-candidates.csv");
const BOARD_MEMBER_DIR = path.join(ROOT, "work/cache/sector-filter-backtest/board-members");
const KLINE_DIR = path.join(ROOT, "work/cache/eastmoney-popularity-backtest/kline");
const STOCK_META_FILE = path.join(ROOT, "work/cache/strategy-dashboard/stock-meta.json");
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_MODE = process.env.DATA_MODE || "auto";
const KLINE_DB_START_DATE = process.env.KLINE_DB_START_DATE || "2024-01-01";
const DEFAULT_SYNC_LOOKBACK_DAYS = 60;
const DEFAULT_SYNC_MAX_STOCKS = 20;
const DAILY_SYNC_JOB = "daily-kline-refresh";
const THS_SYNC_JOB = "ths-popularity-refresh";
const DEFAULT_THS_WATCHLIST_MAX = 20;
const KLINE_FETCH_TIMEOUT_MS = Number(process.env.KLINE_FETCH_TIMEOUT_MS || 15000);
const MARKET_INDEX = {
  key: "csi300",
  name: "沪深300",
  code: "000300",
  secid: "1.000300",
};

const PSEUDO_BOARD_RE =
  /(百日|新高|新低|昨日|近期|最近|连板|涨停|打板|首板|触板|一字|破板|竞价|低价|高价|融资|沪股通|深股通|破净|红利|ST|季报|年报|预增|预盈|预亏|业绩|基金|重仓|成份|送转|转债|MSCI|富时|标普|证金|养老金)/;

const DATA_SOURCES = {
  em: {
    key: "em",
    label: "东方财富历史人气",
    shortLabel: "东方财富",
    description: "东方财富历史人气 + 东方财富行情/板块缓存，本地回测生成",
  },
  ths: {
    key: "ths",
    label: "同花顺本地积累",
    shortLabel: "同花顺",
    description: "同花顺人气榜每日采集后形成的本地历史数据",
    sourceFile: THS_CANDIDATES_FILE,
  },
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

let cachedData;
let cachedHotData;
let cachedThsData = new Map();
let cachedDbData = new Map();
let cachedNames;
let cachedStockMeta;
let cachedTradingCalendar;
let dbPool;

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

const STRATEGIES = {
  early: {
    key: "early",
    label: "早期发现策略",
    shortLabel: "早期发现",
    description: "个股人气 400-1200 上移 + 温和放量 + 板块甜区过滤",
    rule: "个股人气 400-1200 上移 + 个股温和放量 + 板块5日3%-15%且板块量能1.2-2",
    ruleItems: ["人气排名 400-1200", "人气相对 20 日前上移", "个股温和放量 1.0-2.5", "板块5日 3%-15%", "板块量能 1.2-2.0"],
    note: "用于提前发现从冷门区升温的股票，更适合作为观察池和候选池。",
  },
  hot: {
    key: "hot",
    label: "热门确认策略",
    shortLabel: "热门确认",
    description: "个股进入人气前100 + 中期排名明显上移 + 量能不过热",
    rule: "个股人气进入前100 + 20日前排名至少上移300名 + 量能0.8-3.5倍 + 个股5日涨幅不超过35%",
    ruleItems: ["人气排名 1-100", "相对 20 日前上移 ≥300", "个股量能 0.8-3.5", "个股5日涨幅 ≤35%", "默认按行业聚合"],
    note: "用于确认已经进入热门区的趋势股。它不是追高指令，仍需要结合回踩、二次启动和收益验证。",
  },
};

const FEATURE_SET = "em-sector-filter-v1";
const CUSTOM_STRATEGY_PREFIX = "custom:";

const STRATEGY_PARAM_DEFS = [
  {
    key: "rankMin",
    label: "人气排名下限",
    type: "integer",
    min: 1,
    max: 5000,
    help: "数值越小越热门。早期发现通常不看前100，而看从冷门区上移的股票。",
  },
  {
    key: "rankMax",
    label: "人气排名上限",
    type: "integer",
    min: 1,
    max: 5000,
    help: "与下限一起形成排名区间，例如 400-1200。",
  },
  {
    key: "rankDelta20Min",
    label: "20日前上移至少",
    type: "integer",
    min: 0,
    max: 5000,
    help: "20日前排名减去当前排名，越大代表人气上升越明显。",
  },
  {
    key: "amountRatioMin",
    label: "个股量能下限",
    type: "number",
    min: 0,
    max: 20,
    step: 0.1,
    help: "当前成交额相对过去均值的倍数，下限太低会引入无量信号。",
  },
  {
    key: "amountRatioMax",
    label: "个股量能上限",
    type: "number",
    min: 0,
    max: 20,
    step: 0.1,
    help: "上限太高容易追到短线已拥挤的股票。",
  },
  {
    key: "stockPrev5MinPct",
    label: "个股5日涨幅下限",
    type: "percent",
    min: -100,
    max: 300,
    step: 0.5,
    help: "信号日前5个交易日的个股涨跌幅，百分比输入。",
  },
  {
    key: "stockPrev5MaxPct",
    label: "个股5日涨幅上限",
    type: "percent",
    min: -100,
    max: 300,
    step: 0.5,
    help: "用于排除已经明显加速的股票。",
  },
  {
    key: "boardRet5MinPct",
    label: "板块5日涨幅下限",
    type: "percent",
    min: -100,
    max: 300,
    step: 0.5,
    help: "板块趋势过滤，百分比输入。",
  },
  {
    key: "boardRet5MaxPct",
    label: "板块5日涨幅上限",
    type: "percent",
    min: -100,
    max: 300,
    step: 0.5,
    help: "用于避免板块已经过热。",
  },
  {
    key: "boardAmountRatioMin",
    label: "板块量能下限",
    type: "number",
    min: 0,
    max: 20,
    step: 0.1,
    help: "板块成交量能相对均值的倍数。",
  },
  {
    key: "boardAmountRatioMax",
    label: "板块量能上限",
    type: "number",
    min: 0,
    max: 20,
    step: 0.1,
    help: "上限用于过滤板块短线过热。",
  },
  {
    key: "maxPerDate",
    label: "每日最多候选",
    type: "integer",
    min: 0,
    max: 100,
    help: "0 表示不过滤；大于 0 时按评分排序截取。",
  },
  {
    key: "requireStrongBoard",
    label: "必须有强板块",
    type: "boolean",
    help: "要求行业或概念板块满足强度条件。",
  },
  {
    key: "requireResonance",
    label: "必须个股板块共振",
    type: "boolean",
    help: "要求个股与所属强板块同步走强，并排除孤立异动和明显过热。",
  },
];

const STRATEGY_PARAM_DEFAULTS = {
  early: {
    rankMin: 400,
    rankMax: 1200,
    rankDelta20Min: 1,
    amountRatioMin: 1,
    amountRatioMax: 2.5,
    stockPrev5MinPct: -20,
    stockPrev5MaxPct: 35,
    boardRet5MinPct: 3,
    boardRet5MaxPct: 15,
    boardAmountRatioMin: 1.2,
    boardAmountRatioMax: 2,
    maxPerDate: 0,
    requireStrongBoard: true,
    requireResonance: false,
  },
  hot: {
    rankMin: 1,
    rankMax: 100,
    rankDelta20Min: 300,
    amountRatioMin: 0.8,
    amountRatioMax: 3.5,
    stockPrev5MinPct: -20,
    stockPrev5MaxPct: 35,
    boardRet5MinPct: -100,
    boardRet5MaxPct: 300,
    boardAmountRatioMin: 0,
    boardAmountRatioMax: 20,
    maxPerDate: 0,
    requireStrongBoard: false,
    requireResonance: false,
  },
};

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
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

function readStockNames() {
  if (cachedNames) return cachedNames;
  const names = new Map();
  if (!fs.existsSync(BOARD_MEMBER_DIR)) return names;

  for (const file of fs.readdirSync(BOARD_MEMBER_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const rows = JSON.parse(fs.readFileSync(path.join(BOARD_MEMBER_DIR, file), "utf8"));
      for (const row of rows) {
        if (row.code && row.name && !names.has(row.code)) {
          names.set(row.code, row.name);
        }
      }
    } catch {
      // A bad cache file should not prevent the dashboard from opening.
    }
  }
  cachedNames = names;
  return names;
}

function inferStockMeta(code, name = "") {
  const isSt = /(^|\*)ST/.test(name);
  if (/^(688|689)/.test(code)) return { exchange: "SH", board: "科创板", priceLimitPct: isSt ? 0.05 : 0.2, noLimitDays: 5, isSt };
  if (/^(300|301|302)/.test(code)) return { exchange: "SZ", board: "创业板", priceLimitPct: isSt ? 0.05 : 0.2, noLimitDays: 5, isSt };
  if (/^(8|4|920)/.test(code)) return { exchange: "BJ", board: "北交所", priceLimitPct: 0.3, noLimitDays: 1, isSt };
  if (/^6/.test(code)) return { exchange: "SH", board: "沪市主板", priceLimitPct: isSt ? 0.05 : 0.1, noLimitDays: 5, isSt };
  if (/^(000|001|002|003)/.test(code)) return { exchange: "SZ", board: "深市主板", priceLimitPct: isSt ? 0.05 : 0.1, noLimitDays: 5, isSt };
  return { exchange: /^6/.test(code) ? "SH" : "SZ", board: "其他A股", priceLimitPct: isSt ? 0.05 : 0.1, noLimitDays: 5, isSt };
}

function readStockMeta() {
  if (cachedStockMeta) return cachedStockMeta;
  if (!fs.existsSync(STOCK_META_FILE)) {
    cachedStockMeta = new Map();
    return cachedStockMeta;
  }
  const raw = JSON.parse(fs.readFileSync(STOCK_META_FILE, "utf8"));
  cachedStockMeta = new Map(Object.entries(raw.byCode || {}));
  return cachedStockMeta;
}

function daysBetween(start, end) {
  if (!start || !end) return null;
  const startMs = Date.parse(`${start}T00:00:00+08:00`);
  const endMs = Date.parse(`${end}T00:00:00+08:00`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.floor((endMs - startMs) / 86400000);
}

function klineCacheFileForCode(code) {
  const marketId = /^(6|9)/.test(code) ? "1" : "0";
  return path.join(KLINE_DIR, `${marketId}.${code}.json`);
}

function tradingDaysSinceListing(code, listingDate, refDate) {
  const file = klineCacheFileForCode(code);
  if (!listingDate || !refDate || !fs.existsSync(file)) return null;
  try {
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    const eligible = rows.filter((row) => row.date >= listingDate && row.date <= refDate);
    return eligible.length || null;
  } catch {
    return null;
  }
}

function exchangeLabel(exchange) {
  if (exchange === "SH") return "上交所";
  if (exchange === "SZ") return "深交所";
  if (exchange === "BJ") return "北交所";
  return exchange || "";
}

function enrichStockMeta(code, name, refDate) {
  const stored = readStockMeta().get(code) || {};
  const inferred = inferStockMeta(code, stored.name || name);
  const meta = {
    ...inferred,
    ...stored,
    code,
    name: stored.name || name || code,
    exchange: stored.exchange || inferred.exchange,
    board: stored.board || inferred.board,
    priceLimitPct: stored.priceLimitPct ?? inferred.priceLimitPct,
    noLimitDays: stored.noLimitDays ?? inferred.noLimitDays,
    isSt: stored.isSt ?? inferred.isSt,
  };
  const calendarAgeDays = daysBetween(meta.listingDate, refDate);
  const tradingAgeDays = tradingDaysSinceListing(code, meta.listingDate, refDate);
  const effectiveAge = tradingAgeDays ?? calendarAgeDays;
  const isNoLimitWindow = Number.isFinite(tradingAgeDays)
    ? tradingAgeDays > 0 && tradingAgeDays <= meta.noLimitDays
    : Number.isFinite(calendarAgeDays) && calendarAgeDays >= 0 && calendarAgeDays <= meta.noLimitDays * 2;
  const newStage =
    calendarAgeDays === 0
      ? "上市首日"
      : Number.isFinite(calendarAgeDays) && calendarAgeDays <= 30
        ? "新股"
        : Number.isFinite(calendarAgeDays) && calendarAgeDays <= 180
          ? "次新股"
          : "";
  const tags = [
    exchangeLabel(meta.exchange),
    meta.board,
    `${Math.round((meta.priceLimitPct || 0) * 100)}%涨跌幅`,
    isNoLimitWindow ? "上市初期无涨跌幅" : "",
    newStage,
    meta.isSt ? "ST/风险警示" : "",
  ].filter(Boolean);
  return {
    ...meta,
    exchangeLabel: exchangeLabel(meta.exchange),
    calendarAgeDays,
    tradingAgeDays: effectiveAge,
    isNoLimitWindow,
    newStage,
    tags,
    priceLimitLabel: `${Math.round((meta.priceLimitPct || 0) * 100)}%涨跌幅`,
  };
}

function n(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return "";
}

function normalizeYmd(value) {
  const date = normalizeDate(value);
  if (date) return date.replaceAll("-", "");
  return chinaDateYmd();
}

function dateFromYmd(value) {
  const text = String(value || "").trim();
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return normalizeDate(text);
}

function chinaDateYmd(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .replaceAll("-", "");
}

function chinaMinuteKey(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}`;
}

function thsSnapshotTimeFromKey(key) {
  const text = String(key || "");
  if (!/^\d{12}$/.test(text)) return null;
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:00+08:00`;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function scoreEvent(event) {
  const rankGain = event.rank20 && event.rank ? clamp((event.rank20 - event.rank) / 1800) : 0;
  const boardStrength = event.bestBoardRet5 !== null ? clamp((event.bestBoardRet5 - 0.03) / 0.12) : 0;
  const amountFit = event.amountRatio !== null ? 1 - clamp(Math.abs(event.amountRatio - 1.55) / 0.95) : 0;
  const boardAmountFit =
    event.bestBoardAmountRatio !== null ? 1 - clamp(Math.abs(event.bestBoardAmountRatio - 1.55) / 0.6) : 0;
  const stockMomentum = event.prev5 !== null ? clamp((event.prev5 + 0.02) / 0.28) : 0;
  return Math.round(100 * (0.36 * rankGain + 0.24 * boardStrength + 0.18 * amountFit + 0.14 * boardAmountFit + 0.08 * stockMomentum));
}

function scoreHotEvent(event) {
  const rankStrength = event.rank ? clamp((120 - event.rank) / 120) : 0;
  const rankGain20 = event.rank20 && event.rank ? clamp((event.rank20 - event.rank) / 2500) : 0;
  const rankGain10 = event.rank10 && event.rank ? clamp((event.rank10 - event.rank) / 1200) : 0;
  const amountFit = event.amountRatio !== null ? 1 - clamp(Math.abs(event.amountRatio - 1.8) / 1.8) : 0;
  const stockHeat =
    event.prev5 === null ? 0.5 : event.prev5 <= 0.18 ? 1 : event.prev5 <= 0.28 ? 0.65 : event.prev5 <= 0.35 ? 0.35 : 0;
  return Math.round(100 * (0.3 * rankStrength + 0.3 * rankGain20 + 0.15 * rankGain10 + 0.15 * amountFit + 0.1 * stockHeat));
}

function riskFlags(event) {
  const flags = [];
  if (event.prev5 !== null && event.prev5 > 0.22) flags.push("个股5日涨幅偏高");
  if (event.bestBoardRet5 !== null && event.bestBoardRet5 > 0.13) flags.push("板块接近过热");
  if (event.amountRatio !== null && event.amountRatio > 2.1) flags.push("个股量能偏高");
  if (event.bestBoardAmountRatio !== null && event.bestBoardAmountRatio < 1.25) flags.push("板块量能偏弱");
  if (!event.strictBoard) flags.push("伪板块");
  return flags;
}

function hotRiskFlags(event) {
  const flags = [];
  if (event.rank !== null && event.rank <= 10) flags.push("人气极热");
  if (event.prev5 !== null && event.prev5 > 0.25) flags.push("短线涨幅偏高");
  if (event.amountRatio !== null && event.amountRatio > 3) flags.push("量能偏高");
  if (event.amountRatio !== null && event.amountRatio < 1) flags.push("量能偏弱");
  if (event.turnover5 !== null && event.turnover5 > 25) flags.push("换手偏高");
  if (!event.strictBoard) flags.push("伪板块");
  return flags.length ? flags : ["热门确认"];
}

function signalAttributionTags(event, context = {}) {
  const tags = [];
  const daySignalCount = context.daySignalCount ?? event.daySignalCount;
  if (Number.isFinite(daySignalCount) && daySignalCount >= 2) tags.push("多信号日扩散");
  if (Number.isFinite(event.boardHotRatio) && event.boardHotRatio >= 0.8 && event.boardHotRatio < 0.9) tags.push("板块半拥挤");
  if (Number.isFinite(event.boardHotRatio) && event.boardHotRatio >= 0.9) tags.push("板块高拥挤");
  if (Number.isFinite(event.bestBoardAmountRatio) && event.bestBoardAmountRatio >= 1.3 && event.bestBoardAmountRatio < 1.5) {
    tags.push("板块量能不足");
  }
  if (Number.isFinite(event.bestBoardAmountRatio) && event.bestBoardAmountRatio < 1.3) tags.push("板块量能边缘");
  if (Number.isFinite(event.relativeRet5) && event.relativeRet5 >= 0.03 && event.relativeRet5 < 0.06) tags.push("假前排");
  if (Number.isFinite(event.relativeRet5) && event.relativeRet5 <= -0.05) tags.push("个股落后板块");
  if (Number.isFinite(event.boardLeaderPct) && event.boardLeaderPct > 0.65) tags.push("板块后排");
  if (Number.isFinite(event.prev5) && event.prev5 >= 0.15 && Number.isFinite(event.boardHotRatio) && event.boardHotRatio >= 0.85) {
    tags.push("短线追高");
  }
  if (Number.isFinite(event.amountRatio) && event.amountRatio < 1.7) tags.push("个股量能偏弱");
  if (Number.isFinite(event.amountRatio) && event.amountRatio > 2.1) tags.push("个股量能偏高");
  if (event.meta?.priceLimitPct >= 0.2) tags.push("20%高波动");

  return [...new Set(tags)];
}

function signalStrengthScore(event, context = {}) {
  let score = Number.isFinite(event.modelScore) ? event.modelScore : Number.isFinite(event.score) ? event.score : 50;
  const daySignalCount = context.daySignalCount ?? event.daySignalCount;

  if (event.attributionType === "resonance_leader") score += 8;
  if (event.attributionType === "resonance_follow") score += 3;
  if (Number.isFinite(event.relativeRet5) && event.relativeRet5 >= 0.06) score += 10;
  if (Number.isFinite(event.relativeRet5) && event.relativeRet5 >= 0 && event.relativeRet5 < 0.03) score += 5;
  if (Number.isFinite(event.relativeRet5) && event.relativeRet5 >= 0.03 && event.relativeRet5 < 0.06) score -= 4;
  if (Number.isFinite(event.relativeRet5) && event.relativeRet5 <= -0.05) score -= 8;

  if (Number.isFinite(event.boardHotRatio) && event.boardHotRatio >= 0.65 && event.boardHotRatio < 0.8) score += 8;
  if (Number.isFinite(event.boardHotRatio) && event.boardHotRatio >= 0.8 && event.boardHotRatio < 0.9) score -= 12;
  if (Number.isFinite(event.boardHotRatio) && event.boardHotRatio >= 0.9) score += 2;

  if (Number.isFinite(event.bestBoardAmountRatio) && event.bestBoardAmountRatio >= 1.5 && event.bestBoardAmountRatio <= 2.0) score += 8;
  if (Number.isFinite(event.bestBoardAmountRatio) && event.bestBoardAmountRatio >= 1.3 && event.bestBoardAmountRatio < 1.5) score -= 8;
  if (Number.isFinite(event.bestBoardAmountRatio) && event.bestBoardAmountRatio < 1.3) score -= 4;

  if (Number.isFinite(daySignalCount) && daySignalCount === 1) score += 8;
  if (Number.isFinite(daySignalCount) && daySignalCount >= 2) score -= 10;
  if (Number.isFinite(event.prev5) && event.prev5 >= 0.15 && Number.isFinite(event.boardHotRatio) && event.boardHotRatio >= 0.85) score -= 8;

  score -= Math.min((event.riskFlags || []).length * 3, 9);
  return Math.round(clamp(score / 100, 0, 1) * 100);
}

function signalStrengthBand(score) {
  if (!Number.isFinite(score)) return { key: "unknown", label: "未评分" };
  if (score >= 85) return { key: "high", label: "高优先级" };
  if (score >= 70) return { key: "watch", label: "观察池" };
  return { key: "wait", label: "等待确认" };
}

function applySignalQuality(event, context = {}) {
  const riskTags = signalAttributionTags(event, context);
  const strengthScore = signalStrengthScore(event, context);
  const band = signalStrengthBand(strengthScore);
  event.daySignalCount = context.daySignalCount ?? event.daySignalCount ?? null;
  event.riskTags = riskTags;
  event.signalStrength = {
    score: strengthScore,
    band: band.key,
    label: band.label,
  };
  return event;
}

function eventRelativeRet5(event) {
  if (!Number.isFinite(event.prev5) || !Number.isFinite(event.bestBoardRet5)) return null;
  return event.prev5 - event.bestBoardRet5;
}

function eventAttributionType(event) {
  const prev5 = event.prev5;
  const amountRatio = event.amountRatio;
  const boardRet5 = event.bestBoardRet5;
  const boardAmountRatio = event.bestBoardAmountRatio;
  const relativeRet5 = eventRelativeRet5(event);
  const breadthOk = !Number.isFinite(event.boardPositiveRatio) || event.boardPositiveRatio >= 0.42;
  const leaderOk = !Number.isFinite(event.boardLeaderPct) || event.boardLeaderPct <= 0.35;

  const stockStrong = Number.isFinite(prev5) && prev5 >= 0.03 && Number.isFinite(amountRatio) && amountRatio >= 1.1;
  const stockVeryStrong = Number.isFinite(prev5) && prev5 >= 0.08 && Number.isFinite(amountRatio) && amountRatio >= 1.2;
  const boardStrong =
    Number.isFinite(boardRet5) && boardRet5 >= 0.04 && Number.isFinite(boardAmountRatio) && boardAmountRatio >= 1.2 && breadthOk;
  const boardVeryStrong =
    Number.isFinite(boardRet5) && boardRet5 >= 0.08 && Number.isFinite(boardAmountRatio) && boardAmountRatio >= 1.4;
  const outperformsBoard = relativeRet5 !== null && (relativeRet5 >= 0.03 || (leaderOk && relativeRet5 >= 0));
  const lagsBoard = relativeRet5 !== null && relativeRet5 <= -0.03;
  const overheated =
    (Number.isFinite(prev5) && prev5 >= 0.18) ||
    (Number.isFinite(amountRatio) && amountRatio >= 2.8) ||
    (Number.isFinite(boardRet5) && boardRet5 >= 0.16);

  if (overheated && boardStrong && stockStrong) return "overheated_resonance";
  if (overheated) return "overheated_stock";
  if (boardStrong && stockStrong && outperformsBoard) return "resonance_leader";
  if (boardStrong && stockStrong) return "resonance_follow";
  if (boardVeryStrong && lagsBoard) return "board_led_lag";
  if (stockVeryStrong && (!boardStrong || outperformsBoard)) return "stock_led";
  if (stockStrong && (!Number.isFinite(boardRet5) || boardRet5 < 0.02)) return "isolated_stock";
  if (boardStrong) return "board_led";
  return "weak_or_early";
}

function assignAttribution(event) {
  event.relativeRet5 = eventRelativeRet5(event);
  event.attributionType = eventAttributionType(event);
  return event;
}

function isResonanceEvent(event) {
  return event.attributionType === "resonance_leader" || event.attributionType === "resonance_follow";
}

function readKlineRowsSync(code) {
  const file = klineCacheFileForCode(code);
  if (!fs.existsSync(file)) return [];
  try {
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(rows) ? rows.filter((row) => row.date && Number.isFinite(row.open) && Number.isFinite(row.close)) : [];
  } catch {
    return [];
  }
}

function stockReturnBeforeSignal(code, signalDate, days = 5) {
  const rows = readKlineRowsSync(code);
  const index = rows.findIndex((row) => row.date === signalDate);
  if (index < days) return null;
  const current = rows[index]?.close;
  const previous = rows[index - days]?.close;
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / previous;
}

function readTradingCalendar() {
  if (cachedTradingCalendar) return cachedTradingCalendar;
  const dates = new Set();
  const preferredFiles = ["0.000001.json", "1.600519.json", "0.300750.json", "1.688519.json"];
  const addDatesFromFile = (file) => {
    try {
      const rows = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(row.date || "")) dates.add(row.date);
      }
    } catch {
      // Ignore broken cache files; another reference file can still provide the calendar.
    }
  };

  for (const file of preferredFiles) {
    const fullPath = path.join(KLINE_DIR, file);
    if (fs.existsSync(fullPath)) addDatesFromFile(fullPath);
  }

  if (!dates.size && fs.existsSync(KLINE_DIR)) {
    for (const file of fs.readdirSync(KLINE_DIR).filter((item) => item.endsWith(".json")).slice(0, 80)) {
      addDatesFromFile(path.join(KLINE_DIR, file));
    }
  }

  cachedTradingCalendar = [...dates].sort();
  return cachedTradingCalendar;
}

function rowHigh(row) {
  return Number.isFinite(row.high) ? row.high : Math.max(row.open, row.close);
}

function rowLow(row) {
  return Number.isFinite(row.low) ? row.low : Math.min(row.open, row.close);
}

function findTradingIndexSync(rows, date, useNext = false) {
  const exact = rows.findIndex((row) => row.date === date);
  if (exact >= 0) return useNext ? exact + 1 : exact;
  return rows.findIndex((row) => row.date > date);
}

function returnAtSync(rows, entryIndex, entryPrice, days) {
  const exitIndex = entryIndex + days;
  if (entryIndex < 0 || !Number.isFinite(entryPrice) || exitIndex >= rows.length) return null;
  const exit = rows[exitIndex];
  if (!exit || !Number.isFinite(exit.close)) return null;
  return {
    exitDate: exit.date,
    exitClose: exit.close,
    return: (exit.close - entryPrice) / entryPrice,
  };
}

function backfillEventReturns(event) {
  if (event.ret5 !== null && event.ret10 !== null && event.ret20 !== null) return event;
  const rows = readKlineRowsSync(event.code);
  if (!rows.length) return event;
  const entryIndex = findTradingIndexSync(rows, event.signalDate, true);
  const entry = rows[entryIndex];
  if (!entry || !Number.isFinite(entry.open)) return event;

  event.entryDate = event.entryDate || entry.date;
  event.entryOpen = event.entryOpen ?? entry.open;
  event.signalClose = event.signalClose ?? rows.find((row) => row.date === event.signalDate)?.close ?? null;

  for (const days of [5, 10, 20]) {
    const result = returnAtSync(rows, entryIndex, entry.open, days);
    if (!result) continue;
    if (event[`ret${days}`] === null) event[`ret${days}`] = result.return;
    if (!event[`exitDate${days}`]) event[`exitDate${days}`] = result.exitDate;
  }

  return event;
}

function detectSecondaryConfirmation(event) {
  const rows = readKlineRowsSync(event.code);
  const entryIndex = findTradingIndexSync(rows, event.signalDate, true);
  if (entryIndex < 0 || entryIndex >= rows.length) {
    return { status: "待观察", date: null, pullbackPct: null, reboundPct: null, note: "缺少后续K线" };
  }

  const entry = rows[entryIndex];
  const entryPrice = Number.isFinite(event.entryOpen) ? event.entryOpen : entry.open;
  const windowRows = rows.slice(entryIndex, Math.min(rows.length, entryIndex + 11));
  if (windowRows.length < 4) {
    return { status: "待观察", date: null, pullbackPct: null, reboundPct: null, note: "后续交易日不足" };
  }

  let minLow = Infinity;
  let prePullbackHigh = rowHigh(windowRows[0]);
  let pullbackSeen = false;
  let confirm = null;

  for (let i = 0; i < windowRows.length; i += 1) {
    const row = windowRows[i];
    const low = rowLow(row);
    const high = rowHigh(row);
    minLow = Math.min(minLow, low);
    const pullbackPct = (minLow - entryPrice) / entryPrice;
    if (pullbackPct <= -0.05 && pullbackPct >= -0.16) pullbackSeen = true;

    if (!pullbackSeen) {
      prePullbackHigh = Math.max(prePullbackHigh, high);
      continue;
    }

    const reboundPct = (row.close - entryPrice) / entryPrice;
    const breakPreviousHigh = row.close >= prePullbackHigh || high >= prePullbackHigh * 1.02;
    const priceRepaired = reboundPct >= 0.08;
    if (i >= 2 && (breakPreviousHigh || priceRepaired)) {
      confirm = { row, reboundPct, pullbackPct };
      break;
    }
  }

  if (confirm) {
    return {
      status: "已二次确认",
      date: confirm.row.date,
      pullbackPct: confirm.pullbackPct,
      reboundPct: confirm.reboundPct,
      note: "回踩后重新走强",
    };
  }

  const maxHigh = Math.max(...windowRows.map(rowHigh));
  const maxReturn = (maxHigh - entryPrice) / entryPrice;
  if (maxReturn >= 0.12 && minLow > entryPrice * 0.95) {
    return {
      status: "直接走强",
      date: windowRows.find((row) => (rowHigh(row) - entryPrice) / entryPrice >= 0.12)?.date || null,
      pullbackPct: (minLow - entryPrice) / entryPrice,
      reboundPct: maxReturn,
      note: "未明显洗盘，直接上行",
    };
  }

  return {
    status: rows[rows.length - 1].date <= event.signalDate ? "待观察" : "未确认",
    date: null,
    pullbackPct: Number.isFinite(minLow) ? (minLow - entryPrice) / entryPrice : null,
    reboundPct: maxReturn,
    note: "尚未满足二次启动条件",
  };
}

function attachSignalInsights(events) {
  const byCode = new Map();
  for (const event of events) {
    if (!byCode.has(event.code)) byCode.set(event.code, []);
    byCode.get(event.code).push(event);
  }

  for (const list of byCode.values()) {
    list.sort((a, b) => a.signalDate.localeCompare(b.signalDate) || b.sortScore - a.sortScore);
    const globalFirstDate = list[0]?.signalDate || null;
    let waveFirstDate = globalFirstDate;
    let waveOrder = 0;
    for (let index = 0; index < list.length; index += 1) {
      const event = list[index];
      const previous = list[index - 1] || null;
      const gapFromPrevious = previous ? daysBetween(previous.signalDate, event.signalDate) : null;
      const isWaveFirst = !previous || gapFromPrevious === null || gapFromPrevious > 15;
      if (isWaveFirst) {
        waveFirstDate = event.signalDate;
        waveOrder = 1;
      } else {
        waveOrder += 1;
      }
      const stockAccelerated = event.prev5 !== null && event.prev5 >= 0.2;
      const boardHot = event.bestBoardRet5 !== null && event.bestBoardRet5 >= 0.12;
      const continuation = !isWaveFirst;
      const hotStrategy = event.strategyKey === "hot";
      const daysFromFirst = globalFirstDate ? daysBetween(globalFirstDate, event.signalDate) : null;
      const daysFromWaveFirst = waveFirstDate ? daysBetween(waveFirstDate, event.signalDate) : null;
      const waitForConfirm = hotStrategy || continuation || stockAccelerated || boardHot;
      const secondary = waitForConfirm
        ? detectSecondaryConfirmation(event)
        : { status: "无需等待", date: null, pullbackPct: null, reboundPct: null, note: "未触发过热/延续条件" };
      const tags = [
        hotStrategy ? "热门确认" : "",
        continuation ? "波段延续" : "波段首次",
        hotStrategy && event.rank !== null && event.rank <= 50 ? "人气前50" : "",
        stockAccelerated ? "个股已加速" : "",
        boardHot ? "板块偏热" : "",
        waitForConfirm ? "等待二次确认" : "可按原规则验证",
        secondary.status === "已二次确认" ? "已二次确认" : "",
        secondary.status === "直接走强" ? "直接走强" : "",
      ].filter(Boolean);

      event.signalInsight = {
        firstSignalDate: globalFirstDate,
        waveFirstDate,
        signalOrder: index + 1,
        waveOrder,
        previousSignalDate: previous?.signalDate || null,
        gapFromPrevious,
        daysFromFirst,
        daysFromWaveFirst,
        isFirstSignal: isWaveFirst,
        isWaveFirst,
        isContinuation: continuation,
        stockAccelerated,
        boardHot,
        waitForConfirm,
        secondary,
        tags,
        actionHint: hotStrategy
          ? "热门确认：优先等分歧/回踩确认"
          : waitForConfirm
            ? "观察池：等回踩后再确认"
            : "基础候选：可按原规则验证",
      };
    }
  }
}

function isHotConfirmEvent(event) {
  if (event.rank === null || event.rank > 100) return false;
  if (event.rank20 === null || event.rank20 - event.rank < 300) return false;
  if (event.amountRatio === null || event.amountRatio < 0.8 || event.amountRatio > 3.5) return false;
  if (event.prev5 !== null && event.prev5 > 0.35) return false;
  return true;
}

function loadData() {
  if (cachedData) return cachedData;
  if (!fs.existsSync(EVENTS_FILE)) {
    throw new Error(`Missing events file: ${EVENTS_FILE}`);
  }

  const names = readStockNames();
  const stockMeta = readStockMeta();
  const rows = parseCsv(fs.readFileSync(EVENTS_FILE, "utf8"));
  const backtestEvents = rows
    .map((row) => {
      const event = {
        source: "回测事件",
        strategyKey: "early",
        em: row.em,
        code: row.code,
        name: stockMeta.get(row.code)?.name || names.get(row.code) || row.code,
        signalDate: row.signalDate,
        entryDate: row.entryDate,
        exitDate5: row.exitDate5 || null,
        exitDate10: row.exitDate10 || null,
        exitDate20: row.exitDate20 || null,
        rank: n(row.rank),
        rank5: null,
        rank10: null,
        rank20: n(row.rank20),
        median5: n(row.median5),
        medianPrev5: n(row.medianPrev5),
        medianPrev10: n(row.medianPrev10),
        entryOpen: n(row.entryOpen),
        signalClose: n(row.signalClose),
        prev5: n(row.prev5),
        prev10: n(row.prev10),
        amountRatio: n(row.amountRatio),
        turnover5: n(row.turnover5),
        ret5: n(row.ret5),
        ret10: n(row.ret10),
        ret20: n(row.ret20),
        boardCount: n(row.boardCount),
        bestBoardType: row.bestBoardType,
        bestBoardCode: row.bestBoardCode,
        bestBoardName: row.bestBoardName,
        bestBoardRet5: n(row.bestBoardRet5),
        bestBoardRet10: n(row.bestBoardRet10),
        bestBoardAmountRatio: n(row.bestBoardAmountRatio),
        bestBoardScoreRankPct: n(row.bestBoardScoreRankPct),
        hasStrongIndustry: row.hasStrongIndustry === "true",
        hasStrongConcept: row.hasStrongConcept === "true",
      };
      event.strictBoard = !PSEUDO_BOARD_RE.test(event.bestBoardName || "");
      event.meta = enrichStockMeta(event.code, event.name, event.signalDate);
      event.score = scoreEvent(event);
      event.modelScore = null;
      event.sortScore = event.score;
      assignAttribution(event);
      event.riskFlags = riskFlags(event);
      return event;
    })
    .sort((a, b) => a.signalDate.localeCompare(b.signalDate) || b.sortScore - a.sortScore);

  const recentEvents = fs.existsSync(RECENT_CANDIDATES_FILE)
    ? parseCsv(fs.readFileSync(RECENT_CANDIDATES_FILE, "utf8")).map((row) => {
        const event = {
          source: "最新候选",
          strategyKey: "early",
          em: `${row.code?.startsWith("6") ? "SH" : "SZ"}${row.code}`,
          code: row.code,
          name: stockMeta.get(row.code)?.name || row.name || names.get(row.code) || row.code,
          signalDate: row.signalDate,
          entryDate: null,
          exitDate5: null,
          exitDate10: null,
          exitDate20: null,
          rank: n(row.rank),
          rank5: null,
          rank10: null,
          rank20: n(row.rank20),
          median5: n(row.median5),
          medianPrev5: null,
          medianPrev10: n(row.medianPrev10),
          entryOpen: null,
          signalClose: null,
          prev5: n(row.stockPrev5),
          prev10: null,
          amountRatio: n(row.stockAmountRatio),
          turnover5: null,
          ret5: null,
          ret10: null,
          ret20: null,
          boardCount: null,
          bestBoardType: row.boardType,
          bestBoardCode: "",
          bestBoardName: row.boardName,
          bestBoardRet5: n(row.boardRet5),
          bestBoardRet10: n(row.boardRet10),
          bestBoardAmountRatio: n(row.boardAmountRatio),
          bestBoardScoreRankPct: n(row.boardScoreRankPct),
          hasStrongIndustry: row.boardType === "industry",
          hasStrongConcept: row.boardType === "concept",
        };
        event.strictBoard = !PSEUDO_BOARD_RE.test(event.bestBoardName || "");
        event.meta = enrichStockMeta(event.code, event.name, event.signalDate);
        event.score = scoreEvent(event);
        event.modelScore = n(row.finalScore) ?? n(row.score);
        event.sortScore = event.modelScore ?? event.score;
        assignAttribution(event);
        event.riskFlags = riskFlags(event);
        return event;
      })
    : [];

  cachedData = finalizeData([...backtestEvents, ...recentEvents], EVENTS_FILE, "em", {
    strategy: STRATEGIES.early,
  });
  return cachedData;
}

function loadHotData() {
  if (cachedHotData) return cachedHotData;
  if (!fs.existsSync(HOT_EVENTS_FILE)) {
    throw new Error(`Missing hot events file: ${HOT_EVENTS_FILE}`);
  }

  const names = readStockNames();
  const stockMeta = readStockMeta();
  const rows = parseCsv(fs.readFileSync(HOT_EVENTS_FILE, "utf8"));
  const events = rows
    .map((row) => {
      const code = String(row.code || "").match(/\d{6}/)?.[0] || "";
      const signalDate = normalizeDate(row.signalDate);
      if (!code || !signalDate) return null;
      const meta = enrichStockMeta(code, stockMeta.get(code)?.name || row.name || names.get(code) || code, signalDate);
      const event = {
        source: "热门确认",
        strategyKey: "hot",
        em: `${code.startsWith("6") ? "SH" : "SZ"}${code}`,
        code,
        name: meta.name || row.name || names.get(code) || code,
        signalDate,
        entryDate: row.entryDate || null,
        exitDate5: row.exitDate5 || null,
        exitDate10: row.exitDate10 || null,
        exitDate20: row.exitDate20 || null,
        rank: n(row.rank),
        rank5: n(row.rank5),
        rank10: n(row.rank10),
        rank20: n(row.rank20),
        median5: n(row.median5),
        medianPrev5: n(row.medianPrev5),
        medianPrev10: n(row.medianPrev10),
        entryOpen: n(row.entryOpen),
        signalClose: n(row.signalClose),
        prev5: stockReturnBeforeSignal(code, signalDate, 5),
        prev10: stockReturnBeforeSignal(code, signalDate, 10),
        amountRatio: n(row.volumeRatio),
        turnover5: n(row.turnover5),
        ret5: n(row.ret5),
        ret10: n(row.ret10),
        ret20: n(row.ret20),
        boardCount: null,
        bestBoardType: "industry",
        bestBoardCode: "",
        bestBoardName: meta.industry || meta.concepts?.[0] || meta.board || "未分类",
        bestBoardRet5: null,
        bestBoardRet10: null,
        bestBoardAmountRatio: null,
        bestBoardScoreRankPct: null,
        hasStrongIndustry: Boolean(meta.industry),
        hasStrongConcept: false,
      };
      event.strictBoard = !PSEUDO_BOARD_RE.test(event.bestBoardName || "");
      event.meta = meta;
      if (!isHotConfirmEvent(event)) return null;
      event.score = scoreHotEvent(event);
      event.modelScore = null;
      event.sortScore = event.score;
      assignAttribution(event);
      event.riskFlags = hotRiskFlags(event);
      return event;
    })
    .filter(Boolean);

  cachedHotData = finalizeData(events, HOT_EVENTS_FILE, "em", {
    strategy: STRATEGIES.hot,
  });
  return cachedHotData;
}

function finalizeData(inputEvents, sourceFile, sourceKey, extraSource = {}) {
  const eventMap = new Map();
  for (const event of inputEvents) {
    const key = `${event.signalDate}:${event.code}:${event.bestBoardType}:${event.bestBoardName}`;
    const existing = eventMap.get(key);
    if (!existing) {
      eventMap.set(key, event);
      continue;
    }
    const existingHasReturn = existing.ret5 !== null || existing.ret10 !== null || existing.ret20 !== null;
    const eventHasReturn = event.ret5 !== null || event.ret10 !== null || event.ret20 !== null;
    if (eventHasReturn && !existingHasReturn) eventMap.set(key, { ...event, modelScore: existing.modelScore, sortScore: existing.sortScore });
  }

  const events = [...eventMap.values()]
    .map(backfillEventReturns)
    .sort((a, b) => a.signalDate.localeCompare(b.signalDate) || b.sortScore - a.sortScore);
  attachSignalInsights(events);

  const strictEvents = events.filter((event) => event.strictBoard);
  const dates = [...new Set(strictEvents.map((event) => event.signalDate))].sort();
  const allDates = [...new Set(events.map((event) => event.signalDate))].sort();
  const byDate = new Map();
  const allByDate = new Map();

  for (const event of strictEvents) {
    if (!byDate.has(event.signalDate)) byDate.set(event.signalDate, []);
    byDate.get(event.signalDate).push(event);
  }
  for (const event of events) {
    if (!allByDate.has(event.signalDate)) allByDate.set(event.signalDate, []);
    allByDate.get(event.signalDate).push(event);
  }

  const config = DATA_SOURCES[sourceKey] || DATA_SOURCES.em;
  return {
    generatedAt: new Date().toISOString(),
    sourceFile,
    sourceKey,
    dataSource: {
      ...config,
      ...extraSource,
      strategy: extraSource.strategy || STRATEGIES.early,
      sourceFile,
      available: extraSource.available ?? events.length > 0,
    },
    events,
    strictEvents,
    dates,
    allDates,
    byDate,
    allByDate,
  };
}

function emptyData(sourceKey, sourceFile, message) {
  return finalizeData([], sourceFile, sourceKey, {
    available: false,
    message,
  });
}

function normalizeSourceKey(raw) {
  return DATA_SOURCES[raw] ? raw : "em";
}

function isCustomStrategyKey(raw) {
  return String(raw || "").startsWith(CUSTOM_STRATEGY_PREFIX);
}

function customStrategyId(raw) {
  return isCustomStrategyKey(raw) ? String(raw).slice(CUSTOM_STRATEGY_PREFIX.length) : "";
}

function normalizeStrategyKey(raw) {
  if (isCustomStrategyKey(raw) && customStrategyId(raw)) return String(raw);
  return STRATEGIES[raw] ? raw : "early";
}

function asNumber(value, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  const clamped = Math.min(max, Math.max(min, safe));
  return integer ? Math.trunc(clamped) : clamped;
}

function asBoolean(value, fallback = false) {
  if (value === true || value === "true" || value === "1" || value === 1) return true;
  if (value === false || value === "false" || value === "0" || value === 0) return false;
  return fallback;
}

function defaultParamsForStrategy(strategyKey = "early") {
  return { ...(STRATEGY_PARAM_DEFAULTS[strategyKey] || STRATEGY_PARAM_DEFAULTS.early) };
}

function normalizeStrategyParams(input = {}, baseKey = "early") {
  const defaults = defaultParamsForStrategy(baseKey);
  const params = {
    rankMin: asNumber(input.rankMin, defaults.rankMin, { min: 1, max: 5000, integer: true }),
    rankMax: asNumber(input.rankMax, defaults.rankMax, { min: 1, max: 5000, integer: true }),
    rankDelta20Min: asNumber(input.rankDelta20Min, defaults.rankDelta20Min, { min: 0, max: 5000, integer: true }),
    amountRatioMin: asNumber(input.amountRatioMin, defaults.amountRatioMin, { min: 0, max: 20 }),
    amountRatioMax: asNumber(input.amountRatioMax, defaults.amountRatioMax, { min: 0, max: 20 }),
    stockPrev5MinPct: asNumber(input.stockPrev5MinPct, defaults.stockPrev5MinPct, { min: -100, max: 300 }),
    stockPrev5MaxPct: asNumber(input.stockPrev5MaxPct, defaults.stockPrev5MaxPct, { min: -100, max: 300 }),
    boardRet5MinPct: asNumber(input.boardRet5MinPct, defaults.boardRet5MinPct, { min: -100, max: 300 }),
    boardRet5MaxPct: asNumber(input.boardRet5MaxPct, defaults.boardRet5MaxPct, { min: -100, max: 300 }),
    boardAmountRatioMin: asNumber(input.boardAmountRatioMin, defaults.boardAmountRatioMin, { min: 0, max: 20 }),
    boardAmountRatioMax: asNumber(input.boardAmountRatioMax, defaults.boardAmountRatioMax, { min: 0, max: 20 }),
    maxPerDate: asNumber(input.maxPerDate, defaults.maxPerDate, { min: 0, max: 100, integer: true }),
    requireStrongBoard: asBoolean(input.requireStrongBoard, defaults.requireStrongBoard),
    requireResonance: asBoolean(input.requireResonance, defaults.requireResonance),
  };

  if (params.rankMin > params.rankMax) [params.rankMin, params.rankMax] = [params.rankMax, params.rankMin];
  if (params.amountRatioMin > params.amountRatioMax) {
    [params.amountRatioMin, params.amountRatioMax] = [params.amountRatioMax, params.amountRatioMin];
  }
  if (params.stockPrev5MinPct > params.stockPrev5MaxPct) {
    [params.stockPrev5MinPct, params.stockPrev5MaxPct] = [params.stockPrev5MaxPct, params.stockPrev5MinPct];
  }
  if (params.boardRet5MinPct > params.boardRet5MaxPct) {
    [params.boardRet5MinPct, params.boardRet5MaxPct] = [params.boardRet5MaxPct, params.boardRet5MinPct];
  }
  if (params.boardAmountRatioMin > params.boardAmountRatioMax) {
    [params.boardAmountRatioMin, params.boardAmountRatioMax] = [params.boardAmountRatioMax, params.boardAmountRatioMin];
  }
  return params;
}

function createCustomStrategyId() {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function percentRule(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${number.toFixed(Math.abs(number) % 1 ? 1 : 0)}%`;
}

function paramsToRuleItems(params) {
  return [
    `人气排名 ${params.rankMin}-${params.rankMax}`,
    `人气相对 20 日前上移 ≥${params.rankDelta20Min}`,
    `个股温和放量 ${params.amountRatioMin}-${params.amountRatioMax}`,
    `个股5日 ${percentRule(params.stockPrev5MinPct)}-${percentRule(params.stockPrev5MaxPct)}`,
    `板块5日 ${percentRule(params.boardRet5MinPct)}-${percentRule(params.boardRet5MaxPct)}`,
    `板块量能 ${params.boardAmountRatioMin}-${params.boardAmountRatioMax}`,
    params.maxPerDate ? `每日最多 ${params.maxPerDate} 只` : "每日候选不限数量",
    params.requireStrongBoard ? "必须匹配强板块" : "不强制强板块",
    params.requireResonance ? "必须个股板块共振" : "不强制共振归因",
  ];
}

function customStrategyDescriptor(config) {
  const params = normalizeStrategyParams(config.params || {}, "early");
  const label = config.name || "自定义策略";
  return {
    key: `${CUSTOM_STRATEGY_PREFIX}${config.id}`,
    id: config.id,
    label,
    shortLabel: label,
    description: config.description || "基于完整特征池动态重算的自定义策略",
    rule: paramsToRuleItems(params).slice(0, 6).join(" + "),
    ruleItems: paramsToRuleItems(params),
    note: config.description || "自定义策略基于特征池重新筛选候选；保存后会按参数重新计算候选池和测评结果。",
    custom: true,
    params,
  };
}

function builtinStrategyDescriptor(strategyKey) {
  const strategy = STRATEGIES[strategyKey] || STRATEGIES.early;
  return {
    ...strategy,
    custom: false,
    params: normalizeStrategyParams(STRATEGY_PARAM_DEFAULTS[strategyKey] || STRATEGY_PARAM_DEFAULTS.early, strategyKey),
  };
}

function strategyConfigRowToObject(row) {
  return {
    id: row.id,
    source: row.source || "em",
    name: row.name,
    description: row.description || "",
    params: normalizeStrategyParams(row.params || {}, "early"),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function listStrategyConfigs(sourceKey = "em") {
  if (!process.env.DATABASE_URL) return [];
  const { rows } = await getDbPool().query(
    `
      select id, source, name, description, params, created_at, updated_at
      from strategy_configs
      where source = $1
      order by updated_at desc
    `,
    [sourceKey],
  );
  return rows.map(strategyConfigRowToObject);
}

async function getStrategyConfig(id, sourceKey = "em") {
  if (!process.env.DATABASE_URL) return null;
  const { rows } = await getDbPool().query(
    `
      select id, source, name, description, params, created_at, updated_at
      from strategy_configs
      where id = $1 and source = $2
      limit 1
    `,
    [id, sourceKey],
  );
  return rows[0] ? strategyConfigRowToObject(rows[0]) : null;
}

async function saveStrategyConfigPayload(body = {}) {
  requireDatabase();
  const sourceKey = normalizeSourceKey(body.source || "em");
  const id = String(body.id || "").match(/^[a-zA-Z0-9:_-]{3,80}$/) ? String(body.id) : createCustomStrategyId();
  const name = String(body.name || "").trim().slice(0, 80) || "我的策略";
  const description = String(body.description || "").trim().slice(0, 500);
  const params = normalizeStrategyParams(body.params || {}, body.baseStrategy || "early");
  const { rows } = await getDbPool().query(
    `
      insert into strategy_configs (id, source, name, description, params, updated_at)
      values ($1, $2, $3, $4, $5::jsonb, now())
      on conflict (id) do update set
        source = excluded.source,
        name = excluded.name,
        description = excluded.description,
        params = excluded.params,
        updated_at = now()
      returning id, source, name, description, params, created_at, updated_at
    `,
    [id, sourceKey, name, description, JSON.stringify(params)],
  );
  cachedDbData.delete(`${sourceKey}:${CUSTOM_STRATEGY_PREFIX}${id}`);
  const config = strategyConfigRowToObject(rows[0]);
  return { config, strategy: customStrategyDescriptor(config) };
}

async function loadThsData(strategyKey = "early") {
  if (strategyKey === "hot") return loadThsSnapshotHotData({ sourceKey: "ths" });

  const cacheKey = `ths:${strategyKey}`;
  if (cachedThsData.has(cacheKey)) return cachedThsData.get(cacheKey);
  if (!fs.existsSync(THS_CANDIDATES_FILE)) {
    const data = emptyData(
      "ths",
      THS_CANDIDATES_FILE,
      "同花顺历史人气数据尚未积累。开始每日采集后，把统一格式文件写入 outputs/ths-popularity-strategy-candidates.csv 即可在这里回测。",
    );
    cachedThsData.set(cacheKey, data);
    return data;
  }

  const names = readStockNames();
  const stockMeta = readStockMeta();
  const rows = parseCsv(fs.readFileSync(THS_CANDIDATES_FILE, "utf8"));
  const events = rows
    .map((row) => {
      const code = String(row.code || "").match(/\d{6}/)?.[0] || "";
      const signalDate = normalizeDate(row.signalDate || row.date);
      if (!code || !signalDate) return null;
      const event = {
        source: "同花顺本地积累",
        em: `${code.startsWith("6") ? "SH" : "SZ"}${code}`,
        code,
        name: stockMeta.get(code)?.name || row.name || names.get(code) || code,
        signalDate,
        entryDate: row.entryDate || null,
        exitDate5: row.exitDate5 || null,
        exitDate10: row.exitDate10 || null,
        exitDate20: row.exitDate20 || null,
        rank: n(row.rank || row.hot_rank),
        rank20: n(row.rank20 || row.rank_20d),
        median5: n(row.median5),
        medianPrev5: n(row.medianPrev5),
        medianPrev10: n(row.medianPrev10),
        entryOpen: n(row.entryOpen),
        signalClose: n(row.signalClose),
        prev5: n(row.stockPrev5 || row.prev5),
        prev10: n(row.stockPrev10 || row.prev10),
        amountRatio: n(row.stockAmountRatio || row.amountRatio),
        turnover5: n(row.turnover5),
        ret5: n(row.ret5),
        ret10: n(row.ret10),
        ret20: n(row.ret20),
        boardCount: n(row.boardCount),
        bestBoardType: row.boardType || row.bestBoardType || (row.concept || row.boardName ? "concept" : ""),
        bestBoardCode: row.boardCode || row.bestBoardCode || "",
        bestBoardName: row.boardName || row.bestBoardName || row.concept || "",
        bestBoardRet5: n(row.boardRet5 || row.bestBoardRet5),
        bestBoardRet10: n(row.boardRet10 || row.bestBoardRet10),
        bestBoardAmountRatio: n(row.boardAmountRatio || row.bestBoardAmountRatio),
        bestBoardScoreRankPct: n(row.boardScoreRankPct || row.bestBoardScoreRankPct),
        hasStrongIndustry: row.boardType === "industry" || row.bestBoardType === "industry",
        hasStrongConcept: row.boardType === "concept" || row.bestBoardType === "concept" || Boolean(row.concept),
      };
      event.strictBoard = !PSEUDO_BOARD_RE.test(event.bestBoardName || "");
      event.meta = enrichStockMeta(event.code, event.name, event.signalDate);
      event.score = scoreEvent(event);
      event.modelScore = n(row.finalScore) ?? n(row.score);
      event.sortScore = event.modelScore ?? event.score;
      assignAttribution(event);
      event.riskFlags = riskFlags(event);
      return event;
    })
    .filter(Boolean);

  const data = finalizeData(events, THS_CANDIDATES_FILE, "ths", {
    strategy: STRATEGIES.early,
    available: events.length > 0,
    message: events.length ? "" : "同花顺统一数据文件存在，但没有可用候选记录。",
  });
  cachedThsData.set(cacheKey, data);
  return data;
}

function shouldUseDatabase(sourceKey) {
  return sourceKey === "em" && DATA_MODE !== "csv" && Boolean(process.env.DATABASE_URL);
}

function getDbPool() {
  if (!dbPool) {
    dbPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 3,
    });
  }
  return dbPool;
}

async function resolveStockDisplayName(code, fallbackName) {
  const fallback = String(fallbackName || "").trim();
  if (fallback && fallback !== code) return fallback;
  if (!process.env.DATABASE_URL) return fallback || code;

  try {
    const { rows } = await getDbPool().query(
      `
        with candidates as (
          select name, 1 as priority
          from stocks
          where code = $1
          union all
          select name, 2 as priority
          from strategy_signals
          where code = $1
          union all
          select name, 3 as priority
          from popularity_snapshots
          where code = $1
        )
        select name
        from candidates
        where nullif(trim(name), '') is not null
          and trim(name) <> $1
        order by priority asc
        limit 1
      `,
      [code],
    );
    return rows[0]?.name || fallback || code;
  } catch {
    return fallback || code;
  }
}

function dbBarRowToKline(row) {
  return {
    date: normalizeDate(row.trade_date),
    open: n(row.open),
    close: n(row.close),
    high: n(row.high),
    low: n(row.low),
    volume: n(row.volume),
    amount: n(row.amount),
    turnover: n(row.turnover),
    pct: n(row.pct),
  };
}

function stockPreSignalMetricsFromRows(rows, signalDate) {
  const index = rows.findIndex((row) => row.date === signalDate);
  if (index < 0) return {};
  const current = rows[index];
  const prev5Row = index >= 5 ? rows[index - 5] : null;
  const prev10Row = index >= 10 ? rows[index - 10] : null;
  const amountBaseRows = rows.slice(Math.max(0, index - 20), index).filter((row) => Number.isFinite(row.amount) && row.amount > 0);
  const turnoverRows = rows.slice(Math.max(0, index - 4), index + 1).filter((row) => Number.isFinite(row.turnover));
  const amountBase = avg(amountBaseRows.map((row) => row.amount));
  return {
    prev5:
      prev5Row && Number.isFinite(current.close) && Number.isFinite(prev5Row.close) && prev5Row.close
        ? (current.close - prev5Row.close) / prev5Row.close
        : null,
    prev10:
      prev10Row && Number.isFinite(current.close) && Number.isFinite(prev10Row.close) && prev10Row.close
        ? (current.close - prev10Row.close) / prev10Row.close
        : null,
    amountRatio: amountBase && Number.isFinite(current.amount) ? current.amount / amountBase : null,
    turnover5: avg(turnoverRows.map((row) => row.turnover)),
    signalClose: Number.isFinite(current.close) ? current.close : null,
  };
}

function fillEventReturnsFromRows(event, rows) {
  if (!rows.length) return event;
  const entryIndex = findTradingIndexSync(rows, event.signalDate, true);
  const entry = rows[entryIndex];
  if (!entry || !Number.isFinite(entry.open)) return event;

  event.entryDate = event.entryDate || entry.date;
  event.entryOpen = event.entryOpen ?? entry.open;
  event.signalClose = event.signalClose ?? rows.find((row) => row.date === event.signalDate)?.close ?? null;

  for (const days of [5, 10, 20]) {
    const result = returnAtSync(rows, entryIndex, entry.open, days);
    if (!result) continue;
    if (event[`ret${days}`] === null) event[`ret${days}`] = result.return;
    if (!event[`exitDate${days}`]) event[`exitDate${days}`] = result.exitDate;
  }
  return event;
}

function eventNeedsDbReturnBackfill(event) {
  return event.ret5 === null || event.ret10 === null || event.ret20 === null || !event.entryDate || !Number.isFinite(event.entryOpen);
}

async function backfillDbEventReturns(events) {
  const targets = events.filter(eventNeedsDbReturnBackfill);
  if (!targets.length) return events;

  const codes = [...new Set(targets.map((event) => event.code).filter(Boolean))];
  const minSignalDate = targets
    .map((event) => event.signalDate)
    .filter(Boolean)
    .sort()[0];
  if (!codes.length || !minSignalDate) return events;

  const { rows } = await getDbPool().query(
    `
      select code, trade_date, open, close, high, low
      from stock_daily_bars
      where code = any($1) and trade_date >= $2::date
      order by code asc, trade_date asc
    `,
    [codes, minSignalDate],
  );

  const rowsByCode = new Map();
  for (const row of rows) {
    const code = String(row.code || "");
    const kline = dbBarRowToKline(row);
    if (!code || !kline.date || !Number.isFinite(kline.open) || !Number.isFinite(kline.close)) continue;
    if (!rowsByCode.has(code)) rowsByCode.set(code, []);
    rowsByCode.get(code).push(kline);
  }

  for (const event of targets) {
    fillEventReturnsFromRows(event, rowsByCode.get(event.code) || []);
  }
  return events;
}

function eventNeedsDbPreSignalMetrics(event) {
  return (
    event.prev5 === null ||
    event.prev10 === null ||
    event.amountRatio === null ||
    event.turnover5 === null ||
    event.signalClose === null
  );
}

async function attachDbPreSignalMetrics(events) {
  const targets = events.filter(eventNeedsDbPreSignalMetrics);
  if (!targets.length) return events;

  const codes = [...new Set(targets.map((event) => event.code).filter(Boolean))];
  const minSignalDate = targets
    .map((event) => event.signalDate)
    .filter(Boolean)
    .sort()[0];
  const maxSignalDate = targets
    .map((event) => event.signalDate)
    .filter(Boolean)
    .sort()
    .at(-1);
  if (!codes.length || !minSignalDate || !maxSignalDate) return events;

  const { rows } = await getDbPool().query(
    `
      select code, trade_date, open, close, high, low, volume, amount, turnover, pct
      from stock_daily_bars
      where code = any($1)
        and trade_date >= $2::date - interval '90 day'
        and trade_date <= $3::date
      order by code asc, trade_date asc
    `,
    [codes, minSignalDate, maxSignalDate],
  );

  const rowsByCode = new Map();
  for (const row of rows) {
    const code = String(row.code || "");
    const kline = dbBarRowToKline(row);
    if (!code || !kline.date || !Number.isFinite(kline.close)) continue;
    if (!rowsByCode.has(code)) rowsByCode.set(code, []);
    rowsByCode.get(code).push(kline);
  }

  for (const event of targets) {
    const metrics = stockPreSignalMetricsFromRows(rowsByCode.get(event.code) || [], event.signalDate);
    if (event.prev5 === null && metrics.prev5 !== null) event.prev5 = metrics.prev5;
    if (event.prev10 === null && metrics.prev10 !== null) event.prev10 = metrics.prev10;
    if (event.amountRatio === null && metrics.amountRatio !== null) event.amountRatio = metrics.amountRatio;
    if (event.turnover5 === null && metrics.turnover5 !== null) event.turnover5 = metrics.turnover5;
    if (event.signalClose === null && metrics.signalClose !== null) event.signalClose = metrics.signalClose;
    event.score = event.strategyKey === "hot" ? scoreHotEvent(event) : scoreEvent(event);
    event.sortScore = event.modelScore ?? event.score;
    assignAttribution(event);
    event.riskFlags = event.strategyKey === "hot" ? hotRiskFlags(event) : riskFlags(event);
  }
  return events;
}

async function loadDbData(sourceKey, strategyKey) {
  const cacheKey = `${sourceKey}:${strategyKey}`;
  if (cachedDbData.has(cacheKey)) return cachedDbData.get(cacheKey);

  const { rows } = await getDbPool().query(
    `
      select
        s.*,
        st.exchange,
        st.board,
        st.industry,
        st.region,
        st.concepts,
        st.listing_date
      from strategy_signals s
      left join stocks st on st.code = s.code
      where s.source = $1 and s.strategy = $2
      order by s.signal_date asc, s.rank asc nulls last
    `,
    [sourceKey, strategyKey],
  );

  const events = rows
    .map((row) => dbRowToEvent(row, strategyKey))
    .filter(Boolean)
    .filter((event) => (strategyKey === "hot" ? isHotConfirmEvent(event) : true));
  await backfillDbEventReturns(events);

  const data = finalizeData(events, "neon:strategy_signals", sourceKey, {
    strategy: STRATEGIES[strategyKey],
    description: `${DATA_SOURCES[sourceKey].label}，来自 Neon Postgres`,
    sourceFile: "neon:strategy_signals",
    available: events.length > 0,
    message: events.length ? "" : "Neon 中暂无当前数据源和策略的信号记录。",
  });
  cachedDbData.set(cacheKey, data);
  return data;
}

function snapshotRankWindowMaps(rows) {
  const rankByDate = new Map();
  for (const row of rows) {
    const date = normalizeDate(row.snapshot_date);
    const code = String(row.code || "");
    if (!date || !code) continue;
    if (!rankByDate.has(date)) rankByDate.set(date, new Map());
    rankByDate.get(date).set(code, n(row.rank));
  }
  const dates = [...rankByDate.keys()].sort();
  const dateIndex = new Map(dates.map((date, index) => [date, index]));
  return {
    rankAt(date, code, offset) {
      const index = dateIndex.get(date);
      if (!Number.isFinite(index) || index < offset) return null;
      const priorDate = dates[index - offset];
      return rankByDate.get(priorDate)?.get(code) ?? null;
    },
  };
}

function snapshotRowToHotEvent(row, rankWindows, sourceName = "同花顺热榜快照") {
  const code = String(row.code || "").match(/\d{6}/)?.[0] || "";
  const signalDate = normalizeDate(row.snapshot_date);
  if (!code || !signalDate) return null;

  const concepts = Array.isArray(row.concepts) ? row.concepts : [];
  const baseName = row.name || row.stock_name || code;
  const cachedMeta = enrichStockMeta(code, baseName, signalDate);
  const snapshotConcept = String(row.main_tag || "").trim();
  const exchange = row.exchange || (String(row.market) === "17" ? "SH" : String(row.market) === "33" ? "SZ" : cachedMeta.exchange);
  const meta = {
    ...cachedMeta,
    name: cachedMeta.name || baseName,
    exchange,
    board: row.board || cachedMeta.board,
    industry: row.industry || cachedMeta.industry,
    region: row.region || cachedMeta.region,
    concepts: concepts.length ? concepts : snapshotConcept ? [snapshotConcept] : cachedMeta.concepts || [],
    listingDate: normalizeDate(row.listing_date) || cachedMeta.listingDate,
  };
  const bestBoardName = snapshotConcept || meta.industry || meta.concepts?.[0] || meta.board || "未分类";
  const event = {
    source: sourceName,
    strategyKey: "hot",
    em: `${code.startsWith("6") ? "SH" : "SZ"}${code}`,
    code,
    name: meta.name || baseName,
    signalDate,
    entryDate: null,
    exitDate5: null,
    exitDate10: null,
    exitDate20: null,
    rank: n(row.rank),
    rank5: rankWindows.rankAt(signalDate, code, 5),
    rank10: rankWindows.rankAt(signalDate, code, 10),
    rank20: rankWindows.rankAt(signalDate, code, 20),
    median5: null,
    medianPrev5: null,
    medianPrev10: null,
    entryOpen: null,
    signalClose: null,
    prev5: null,
    prev10: null,
    amountRatio: null,
    turnover5: null,
    ret5: null,
    ret10: null,
    ret20: null,
    boardCount: null,
    bestBoardType: snapshotConcept ? "concept" : meta.industry ? "industry" : "concept",
    bestBoardCode: "",
    bestBoardName,
    bestBoardRet5: null,
    bestBoardRet10: null,
    bestBoardAmountRatio: null,
    bestBoardScoreRankPct: null,
    boardPositiveRatio: null,
    boardHotRatio: null,
    boardStrongRatio: null,
    boardLeaderPct: null,
    boardLeaderRank: null,
    boardMemberExcessRet5: null,
    boardValidMemberCount: null,
    hasStrongIndustry: Boolean(meta.industry),
    hasStrongConcept: Boolean(snapshotConcept || meta.concepts?.length),
    meta,
  };
  event.strictBoard = !PSEUDO_BOARD_RE.test(event.bestBoardName || "");
  event.score = scoreHotEvent(event);
  event.modelScore = null;
  event.sortScore = event.score;
  assignAttribution(event);
  event.riskFlags = hotRiskFlags(event);
  return event;
}

async function loadThsSnapshotHotData({ sourceKey = "ths", afterDate = null, asSupplement = false } = {}) {
  if (!process.env.DATABASE_URL) {
    return emptyData(sourceKey, "neon:popularity_snapshots", "同花顺热榜快照需要先连接数据库。");
  }

  const normalizedAfterDate = normalizeDate(afterDate) || null;
  const cacheKey = `${sourceKey}:ths-snapshot-hot:${normalizedAfterDate || "all"}:${asSupplement ? "supplement" : "direct"}`;
  if (cachedDbData.has(cacheKey)) return cachedDbData.get(cacheKey);

  const { rows } = await getDbPool().query(
    `
      with latest as (
        select snapshot_date, max(snapshot_key) as snapshot_key
        from popularity_snapshots
        where source = 'ths'
          and category = 'stock'
          and metric = 'hot'
        group by snapshot_date
      )
      select
        p.*,
        st.name as stock_name,
        st.exchange,
        st.board,
        st.industry,
        st.region,
        st.concepts,
        st.listing_date
      from popularity_snapshots p
      join latest l on l.snapshot_date = p.snapshot_date and l.snapshot_key = p.snapshot_key
      left join stocks st on st.code = p.code
      where p.source = 'ths'
        and p.category = 'stock'
        and p.metric = 'hot'
        and p.rank between 1 and 100
        and ($1::date is null or p.snapshot_date > $1::date)
      order by p.snapshot_date asc, p.rank asc nulls last
    `,
    [normalizedAfterDate],
  );

  const rankWindows = snapshotRankWindowMaps(rows);
  const sourceName = asSupplement ? "同花顺热榜快照补齐" : "同花顺热榜快照";
  const events = rows.map((row) => snapshotRowToHotEvent(row, rankWindows, sourceName)).filter(Boolean);
  await attachDbPreSignalMetrics(events);
  await backfillDbEventReturns(events);

  const descriptor = {
    ...builtinStrategyDescriptor("hot"),
    note: "基于同花顺每日最终热榜快照生成。近期快照目前覆盖热榜前10左右，20日前排名不足时保留为空。",
  };
  const data = finalizeData(events, "neon:popularity_snapshots(ths.stock.hot)", sourceKey, {
    strategy: descriptor,
    description: asSupplement
      ? "东方财富热门确认缺口日期使用同花顺每日最终热榜快照补齐；该补齐口径目前覆盖热榜前10左右。"
      : "同花顺本地积累，基于每日最终热榜快照动态生成热门确认候选。",
    sourceFile: "neon:popularity_snapshots(ths.stock.hot)",
    available: events.length > 0,
    message: events.length ? "" : "Neon 中暂无同花顺热榜快照。请确认每日采集任务已运行。",
  });
  cachedDbData.set(cacheKey, data);
  return data;
}

function dbRowToEvent(row, strategyKey) {
  const code = String(row.code || "").match(/\d{6}/)?.[0] || "";
  const signalDate = normalizeDate(row.signal_date);
  if (!code || !signalDate) return null;

  const raw = row.raw && typeof row.raw === "object" ? row.raw : {};
  const concepts = Array.isArray(row.concepts) ? row.concepts : [];
  const baseName = row.name || raw.name || code;
  const cachedMeta = enrichStockMeta(code, baseName, signalDate);
  const meta = {
    ...cachedMeta,
    name: cachedMeta.name || baseName,
    exchange: row.exchange || cachedMeta.exchange,
    board: row.board || cachedMeta.board,
    industry: row.industry || cachedMeta.industry,
    region: row.region || cachedMeta.region,
    concepts: concepts.length ? concepts : cachedMeta.concepts || [],
    listingDate: normalizeDate(row.listing_date) || cachedMeta.listingDate,
  };

  const bestBoardType = row.best_board_type || raw.boardType || raw.bestBoardType || (meta.industry ? "industry" : "concept");
  const bestBoardName =
    row.best_board_name || raw.boardName || raw.bestBoardName || meta.industry || meta.concepts?.[0] || meta.board || "未分类";
  const prev5 =
    n(raw.prev5) ??
    n(raw.stockPrev5) ??
    (strategyKey === "hot" ? stockReturnBeforeSignal(code, signalDate, 5) : null);
  const prev10 =
    n(raw.prev10) ??
    n(raw.stockPrev10) ??
    (strategyKey === "hot" ? stockReturnBeforeSignal(code, signalDate, 10) : null);

  const event = {
    source: strategyKey === "hot" ? "Neon 热门确认" : raw.source === "最新候选" ? "Neon 最新候选" : "Neon 回测事件",
    strategyKey,
    em: `${code.startsWith("6") ? "SH" : "SZ"}${code}`,
    code,
    name: meta.name || baseName,
    signalDate,
    entryDate: normalizeDate(row.entry_date) || null,
    exitDate5: normalizeDate(raw.exitDate5) || null,
    exitDate10: normalizeDate(raw.exitDate10) || null,
    exitDate20: normalizeDate(raw.exitDate20) || null,
    rank: n(row.rank),
    rank5: n(row.rank_5),
    rank10: n(row.rank_10),
    rank20: n(row.rank_20),
    median5: n(raw.median5),
    medianPrev5: n(raw.medianPrev5),
    medianPrev10: n(raw.medianPrev10),
    entryOpen: n(row.entry_open),
    signalClose: n(row.signal_close),
    prev5,
    prev10,
    amountRatio: n(row.amount_ratio),
    turnover5: n(row.turnover_5),
    ret5: n(row.ret_5),
    ret10: n(row.ret_10),
    ret20: n(row.ret_20),
    boardCount: n(raw.boardCount),
    bestBoardType,
    bestBoardCode: row.best_board_code || raw.boardCode || raw.bestBoardCode || "",
    bestBoardName,
    bestBoardRet5: n(row.best_board_ret_5),
    bestBoardRet10: n(raw.bestBoardRet10 || raw.boardRet10),
    bestBoardAmountRatio: n(row.best_board_amount_ratio),
    bestBoardScoreRankPct: n(raw.bestBoardScoreRankPct || raw.boardScoreRankPct),
    boardPositiveRatio: n(raw.boardPositiveRatio),
    boardHotRatio: n(raw.boardHotRatio),
    boardStrongRatio: n(raw.boardStrongRatio),
    boardLeaderPct: n(raw.boardLeaderPct),
    boardLeaderRank: n(raw.boardLeaderRank),
    boardMemberExcessRet5: n(raw.boardMemberExcessRet5),
    boardValidMemberCount: n(raw.boardValidMemberCount),
    hasStrongIndustry: bestBoardType === "industry" || raw.hasStrongIndustry === "true",
    hasStrongConcept: bestBoardType === "concept" || raw.hasStrongConcept === "true",
    meta,
  };
  event.strictBoard = !PSEUDO_BOARD_RE.test(event.bestBoardName || "");
  event.score = n(row.score) ?? (strategyKey === "hot" ? scoreHotEvent(event) : scoreEvent(event));
  event.modelScore = n(row.model_score) ?? n(raw.finalScore);
  event.sortScore = event.modelScore ?? event.score;
  assignAttribution(event);
  event.riskFlags = strategyKey === "hot" ? hotRiskFlags(event) : riskFlags(event);
  return event;
}

function featureRowToEvent(row, config) {
  const code = String(row.code || "").match(/\d{6}/)?.[0] || "";
  const signalDate = normalizeDate(row.signal_date);
  if (!code || !signalDate) return null;
  const strategyKey = config.key || (config.id ? `${CUSTOM_STRATEGY_PREFIX}${config.id}` : "early");
  const strategySource = config.sourceName || config.name || STRATEGIES[strategyKey]?.shortLabel || "动态策略";

  const raw = row.raw && typeof row.raw === "object" ? row.raw : {};
  const concepts = Array.isArray(row.concepts) ? row.concepts : [];
  const baseName = row.name || raw.name || code;
  const cachedMeta = enrichStockMeta(code, baseName, signalDate);
  const meta = {
    ...cachedMeta,
    name: cachedMeta.name || baseName,
    exchange: row.exchange || cachedMeta.exchange,
    board: row.board || cachedMeta.board,
    industry: row.industry || cachedMeta.industry,
    region: row.region || cachedMeta.region,
    concepts: concepts.length ? concepts : cachedMeta.concepts || [],
    listingDate: normalizeDate(row.listing_date) || cachedMeta.listingDate,
  };

  const bestBoardType = row.best_board_type || raw.bestBoardType || raw.boardType || (meta.industry ? "industry" : "concept");
  const bestBoardName =
    row.best_board_name || raw.bestBoardName || raw.boardName || meta.industry || meta.concepts?.[0] || meta.board || "未分类";
  const event = {
    source: strategySource,
    strategyKey,
    em: `${code.startsWith("6") ? "SH" : "SZ"}${code}`,
    code,
    name: meta.name || baseName,
    signalDate,
    entryDate: normalizeDate(row.entry_date) || null,
    exitDate5: normalizeDate(raw.exitDate5) || null,
    exitDate10: normalizeDate(raw.exitDate10) || null,
    exitDate20: normalizeDate(raw.exitDate20) || null,
    rank: n(row.rank),
    rank5: n(row.rank_5),
    rank10: n(row.rank_10),
    rank20: n(row.rank_20),
    median5: n(row.median_5),
    medianPrev5: n(row.median_prev_5),
    medianPrev10: n(row.median_prev_10),
    entryOpen: n(row.entry_open),
    signalClose: n(row.signal_close),
    prev5: n(row.prev_5),
    prev10: n(row.prev_10),
    amountRatio: n(row.amount_ratio),
    turnover5: n(row.turnover_5),
    ret5: n(row.ret_5),
    ret10: n(row.ret_10),
    ret20: n(row.ret_20),
    boardCount: n(row.board_count),
    bestBoardType,
    bestBoardCode: row.best_board_code || raw.bestBoardCode || raw.boardCode || "",
    bestBoardName,
    bestBoardRet5: n(row.best_board_ret_5),
    bestBoardRet10: n(row.best_board_ret_10),
    bestBoardAmountRatio: n(row.best_board_amount_ratio),
    bestBoardScoreRankPct: n(row.best_board_score_rank_pct),
    boardPositiveRatio: n(raw.boardPositiveRatio),
    boardHotRatio: n(raw.boardHotRatio),
    boardStrongRatio: n(raw.boardStrongRatio),
    boardLeaderPct: n(raw.boardLeaderPct),
    boardLeaderRank: n(raw.boardLeaderRank),
    boardMemberExcessRet5: n(raw.boardMemberExcessRet5),
    boardValidMemberCount: n(raw.boardValidMemberCount),
    hasStrongIndustry: row.has_strong_industry === true || bestBoardType === "industry",
    hasStrongConcept: row.has_strong_concept === true || bestBoardType === "concept",
    meta,
  };
  event.strictBoard = !PSEUDO_BOARD_RE.test(event.bestBoardName || "");
  event.score = n(row.score) ?? (strategyKey === "hot" ? scoreHotEvent(event) : scoreEvent(event));
  event.modelScore = null;
  event.sortScore = event.score;
  assignAttribution(event);
  event.riskFlags = strategyKey === "hot" ? hotRiskFlags(event) : riskFlags(event);
  return event;
}

function filterMaxPerDate(events, maxPerDate) {
  if (!maxPerDate) return events;
  const byDate = new Map();
  for (const event of events) {
    if (!byDate.has(event.signalDate)) byDate.set(event.signalDate, []);
    byDate.get(event.signalDate).push(event);
  }
  return [...byDate.values()].flatMap((items) =>
    items
      .sort((a, b) => b.sortScore - a.sortScore || (a.rank || 99999) - (b.rank || 99999))
      .slice(0, maxPerDate),
  );
}

async function loadDynamicStrategyData(sourceKey, strategyKey, config, descriptor, baseKey = "early") {
  if (!process.env.DATABASE_URL) {
    return emptyData(sourceKey, "neon:strategy_feature_events", "动态策略计算需要先连接数据库。");
  }
  const cacheKey = `${sourceKey}:dynamic:${strategyKey}`;
  if (cachedDbData.has(cacheKey)) return cachedDbData.get(cacheKey);

  const params = normalizeStrategyParams(config.params || {}, baseKey);
  const { rows } = await getDbPool().query(
    `
      select
        f.*,
        st.exchange,
        st.board,
        st.industry,
        st.region,
        st.concepts,
        st.listing_date
      from strategy_feature_events f
      left join stocks st on st.code = f.code
      where f.source = $1
        and f.feature_set = $2
        and f.rank between $3 and $4
        and coalesce(f.rank_delta_20, f.rank_20 - f.rank) >= $5
        and f.amount_ratio between $6 and $7
        and f.prev_5 between $8 and $9
        and f.best_board_ret_5 between $10 and $11
        and f.best_board_amount_ratio between $12 and $13
        and (
          $14::boolean = false
          or f.has_strong_board is true
          or f.has_strong_industry is true
          or f.has_strong_concept is true
        )
      order by f.signal_date asc, f.rank asc nulls last
    `,
    [
      sourceKey,
      FEATURE_SET,
      params.rankMin,
      params.rankMax,
      params.rankDelta20Min,
      params.amountRatioMin,
      params.amountRatioMax,
      params.stockPrev5MinPct / 100,
      params.stockPrev5MaxPct / 100,
      params.boardRet5MinPct / 100,
      params.boardRet5MaxPct / 100,
      params.boardAmountRatioMin,
      params.boardAmountRatioMax,
      params.requireStrongBoard,
    ],
  );

  let events = rows.map((row) => featureRowToEvent(row, { ...config, params, key: strategyKey })).filter(Boolean);
  if (params.requireResonance) events = events.filter(isResonanceEvent);
  events = filterMaxPerDate(events, params.maxPerDate);
  await backfillDbEventReturns(events);
  const data = finalizeData(events, "neon:strategy_feature_events", sourceKey, {
    strategy: descriptor,
    description: `${DATA_SOURCES[sourceKey]?.label || sourceKey}，${descriptor.custom ? "自定义策略" : "内置策略"}基于完整特征池动态重算`,
    sourceFile: "neon:strategy_feature_events",
    available: events.length > 0,
    message: events.length ? "" : "当前策略没有筛出候选。可以切换策略或放宽参数后重新计算。",
  });
  cachedDbData.set(cacheKey, data);
  return data;
}

async function loadCustomStrategyData(sourceKey, strategyKey) {
  const id = customStrategyId(strategyKey);
  if (!id || !process.env.DATABASE_URL) {
    return emptyData(sourceKey, "neon:strategy_feature_events", "自定义策略需要先连接数据库并保存策略参数。");
  }

  const config = await getStrategyConfig(id, sourceKey);
  if (!config) {
    return emptyData(sourceKey, "neon:strategy_feature_events", "没有找到这个自定义策略，请重新保存策略参数。");
  }
  const descriptor = customStrategyDescriptor(config);
  return loadDynamicStrategyData(
    sourceKey,
    strategyKey,
    {
      ...config,
      key: strategyKey,
      sourceName: config.name || descriptor.shortLabel || descriptor.label,
    },
    descriptor,
    "early",
  );
}

async function loadBuiltinDynamicStrategyData(sourceKey, strategyKey) {
  const cacheKey = `${sourceKey}:dynamic-merged:${strategyKey}`;
  if (cachedDbData.has(cacheKey)) return cachedDbData.get(cacheKey);

  const descriptor = builtinStrategyDescriptor(strategyKey);
  const dynamicData = await loadDynamicStrategyData(
    sourceKey,
    strategyKey,
    {
      id: strategyKey,
      key: strategyKey,
      name: descriptor.label,
      sourceName: descriptor.shortLabel || descriptor.label,
      description: descriptor.description,
      params: descriptor.params,
    },
    descriptor,
    strategyKey,
  );
  const materializedData = await loadDbData(sourceKey, strategyKey);
  const events = [...materializedData.events, ...dynamicData.events];
  let sourceFile = "neon:strategy_feature_events + neon:strategy_signals";
  let description = `${DATA_SOURCES[sourceKey]?.label || sourceKey}，内置策略基于完整特征池动态重算，并用物化信号补齐近期覆盖`;

  if (sourceKey === "em" && strategyKey === "hot") {
    const maxBaseDate = events
      .map((event) => event.signalDate)
      .filter(Boolean)
      .sort()
      .at(-1);
    const snapshotSupplement = await loadThsSnapshotHotData({
      sourceKey: "em",
      afterDate: maxBaseDate,
      asSupplement: true,
    });
    events.push(...snapshotSupplement.events);
    if (snapshotSupplement.events.length) {
      sourceFile += " + neon:popularity_snapshots(ths.stock.hot)";
      description += "；东方财富热门确认缺口日期使用同花顺每日最终热榜快照补齐";
    }
  }

  const data = finalizeData(events, sourceFile, sourceKey, {
    strategy: descriptor,
    description,
    sourceFile,
    available: events.length > 0,
    message: events.length ? "" : "当前策略没有筛出候选；已尝试动态特征池和物化信号兜底。",
  });
  cachedDbData.set(cacheKey, data);
  return data;
}

async function loadDataForSource(rawSource, rawStrategy) {
  const sourceKey = normalizeSourceKey(rawSource);
  const strategyKey = normalizeStrategyKey(rawStrategy);
  if (isCustomStrategyKey(strategyKey)) return loadCustomStrategyData(sourceKey, strategyKey);
  if (sourceKey === "ths") return loadThsData(strategyKey);
  if (shouldUseDatabase(sourceKey)) return loadBuiltinDynamicStrategyData(sourceKey, strategyKey);
  return strategyKey === "hot" ? loadHotData() : loadData();
}

function avg(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function median(values) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function winRate(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (!clean.length) return null;
  return clean.filter((value) => value > 0).length / clean.length;
}

function summarize(events) {
  return {
    count: events.length,
    avgScore: avg(events.map((event) => event.score)),
    avgRet5: avg(events.map((event) => event.ret5)),
    avgRet10: avg(events.map((event) => event.ret10)),
    avgRet20: avg(events.map((event) => event.ret20)),
    medianRet5: median(events.map((event) => event.ret5)),
    medianRet10: median(events.map((event) => event.ret10)),
    medianRet20: median(events.map((event) => event.ret20)),
    win5: winRate(events.map((event) => event.ret5)),
    win10: winRate(events.map((event) => event.ret10)),
    win20: winRate(events.map((event) => event.ret20)),
    matured5: events.filter((event) => event.ret5 !== null).length,
    matured10: events.filter((event) => event.ret10 !== null).length,
    matured20: events.filter((event) => event.ret20 !== null).length,
  };
}

function sum(values) {
  return values.filter(Number.isFinite).reduce((total, value) => total + value, 0);
}

function horizonEvaluation(events, field, label) {
  const matured = events.filter((event) => Number.isFinite(event[field]));
  const values = matured.map((event) => event[field]);
  const wins = values.filter((value) => value > 0);
  const losses = values.filter((value) => value < 0);
  const gain = sum(wins);
  const loss = Math.abs(sum(losses));
  return {
    key: field,
    label,
    sampleCount: events.length,
    maturedCount: matured.length,
    pendingCount: events.length - matured.length,
    coverage: events.length ? matured.length / events.length : null,
    avg: avg(values),
    median: median(values),
    winRate: winRate(values),
    avgWin: avg(wins),
    avgLoss: avg(losses),
    payoffRatio: avg(losses) ? Math.abs((avg(wins) || 0) / avg(losses)) : null,
    profitFactor: loss ? gain / loss : gain ? null : null,
    best: values.length ? Math.max(...values) : null,
    worst: values.length ? Math.min(...values) : null,
  };
}

function dailyEvaluation(events, field) {
  const byDate = new Map();
  for (const event of events) {
    if (!Number.isFinite(event[field])) continue;
    if (!byDate.has(event.signalDate)) byDate.set(event.signalDate, []);
    byDate.get(event.signalDate).push(event[field]);
  }
  return [...byDate.entries()]
    .map(([date, values]) => ({
      date,
      count: values.length,
      avg: avg(values),
      median: median(values),
      winRate: winRate(values),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function diffOrNull(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) ? left - right : null;
}

function attachBaselineToHorizon(strategyHorizon, baselineHorizon) {
  return {
    ...strategyHorizon,
    baseline: baselineHorizon,
    excess: {
      avg: diffOrNull(strategyHorizon.avg, baselineHorizon?.avg),
      median: diffOrNull(strategyHorizon.median, baselineHorizon?.median),
      winRate: diffOrNull(strategyHorizon.winRate, baselineHorizon?.winRate),
      profitFactor: diffOrNull(strategyHorizon.profitFactor, baselineHorizon?.profitFactor),
      payoffRatio: diffOrNull(strategyHorizon.payoffRatio, baselineHorizon?.payoffRatio),
    },
  };
}

function localMarketUniverse() {
  if (!fs.existsSync(KLINE_DIR)) return [];
  return fs
    .readdirSync(KLINE_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const code = path.basename(file, ".json").split(".")[1] || "";
      if (!/^(00|30|60|68)/.test(code)) return null;
      try {
        const rows = JSON.parse(fs.readFileSync(path.join(KLINE_DIR, file), "utf8"));
        if (!Array.isArray(rows) || rows.length < 40) return null;
        return {
          code,
          rows: rows.filter((row) => row.date && Number.isFinite(row.open) && Number.isFinite(row.close)),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function marketReturnFromRows(rows, signalDate, days) {
  const entryIndex = findTradingIndexSync(rows, signalDate, true);
  const entry = rows[entryIndex];
  if (!entry || !Number.isFinite(entry.open)) return null;
  return returnAtSync(rows, entryIndex, entry.open, days)?.return ?? null;
}

function summarizeMarketValues(values) {
  const valid = values.filter(Number.isFinite);
  const wins = valid.filter((value) => value > 0);
  const losses = valid.filter((value) => value < 0);
  const gain = sum(wins);
  const loss = Math.abs(sum(losses));
  return {
    count: valid.length,
    avg: avg(valid),
    median: median(valid),
    winRate: winRate(valid),
    avgWin: avg(wins),
    avgLoss: avg(losses),
    payoffRatio: avg(losses) ? Math.abs((avg(wins) || 0) / avg(losses)) : null,
    profitFactor: loss ? gain / loss : gain ? null : null,
    best: valid.length ? Math.max(...valid) : null,
    worst: valid.length ? Math.min(...valid) : null,
  };
}

function marketDailyStatsFromLocal(dates) {
  const universe = localMarketUniverse();
  const stats = new Map();
  if (!universe.length) return stats;
  for (const date of dates) {
    const ret5 = universe.map((item) => marketReturnFromRows(item.rows, date, 5));
    const ret10 = universe.map((item) => marketReturnFromRows(item.rows, date, 10));
    const ret20 = universe.map((item) => marketReturnFromRows(item.rows, date, 20));
    stats.set(date, {
      ret5: summarizeMarketValues(ret5),
      ret10: summarizeMarketValues(ret10),
      ret20: summarizeMarketValues(ret20),
    });
  }
  return stats;
}

function dbMarketStatsForRow(row, key) {
  const count = n(row[`${key}_count`]);
  const gain = n(row[`${key}_gain`]);
  const loss = n(row[`${key}_loss`]);
  const avgWin = n(row[`${key}_avg_win`]);
  const avgLoss = n(row[`${key}_avg_loss`]);
  return {
    count: count ?? 0,
    avg: n(row[`${key}_avg`]),
    median: n(row[`${key}_median`]),
    winRate: n(row[`${key}_win_rate`]),
    avgWin,
    avgLoss,
    payoffRatio: avgLoss ? Math.abs((avgWin || 0) / avgLoss) : null,
    profitFactor: loss ? (gain || 0) / loss : gain ? null : null,
    best: n(row[`${key}_best`]),
    worst: n(row[`${key}_worst`]),
  };
}

function baselineTableStatsForRow(row) {
  const avgWin = n(row.avg_win);
  const avgLoss = n(row.avg_loss);
  return {
    count: n(row.sample_count) ?? 0,
    avg: n(row.avg_return),
    median: n(row.median_return),
    winRate: n(row.win_rate),
    avgWin,
    avgLoss,
    payoffRatio: n(row.payoff_ratio),
    profitFactor: n(row.profit_factor),
    best: n(row.best_return),
    worst: n(row.worst_return),
  };
}

async function marketDailyStatsFromBaselineTable(dates) {
  if (!dates.length || !process.env.DATABASE_URL) return new Map();
  const { rows } = await getDbPool().query(
    `
      select trade_date, horizon, sample_count, avg_return, median_return, win_rate,
             avg_win, avg_loss, payoff_ratio, profit_factor, best_return, worst_return
      from market_daily_baselines
      where source = 'em'
        and universe = 'local-kline-a-share'
        and trade_date = any($1::date[])
    `,
    [dates],
  );
  const stats = new Map();
  for (const row of rows) {
    const date = normalizeDate(row.trade_date);
    const horizon = row.horizon;
    if (!date || !horizon) continue;
    if (!stats.has(date)) stats.set(date, {});
    stats.get(date)[horizon] = baselineTableStatsForRow(row);
  }
  return stats;
}

async function marketDailyStatsFromDb(dates) {
  if (!dates.length || !process.env.DATABASE_URL) return new Map();

  const valueSql = dates.map((_, index) => `($${index + 1}::date)`).join(", ");
  const minDateParam = dates.length + 1;
  const maxDateParam = dates.length + 2;
  const params = [...dates, dates[0], dates[dates.length - 1]];

  const { rows } = await getDbPool().query(
    `
      with requested(signal_date) as (
        values ${valueSql}
      ),
      bars as (
        select
          code,
          trade_date,
          lead(open, 1) over w as entry_open,
          lead(close, 6) over w as exit5_close,
          lead(close, 11) over w as exit10_close,
          lead(close, 21) over w as exit20_close
        from stock_daily_bars
        where code ~ '^(00|30|60|68)'
          and trade_date >= $${minDateParam}::date
          and trade_date <= $${maxDateParam}::date + interval '45 days'
        window w as (partition by code order by trade_date)
      ),
      returns as (
        select
          r.signal_date,
          b.code,
          case when b.entry_open > 0 and b.exit5_close is not null then (b.exit5_close - b.entry_open) / b.entry_open end as ret5,
          case when b.entry_open > 0 and b.exit10_close is not null then (b.exit10_close - b.entry_open) / b.entry_open end as ret10,
          case when b.entry_open > 0 and b.exit20_close is not null then (b.exit20_close - b.entry_open) / b.entry_open end as ret20
        from requested r
        join bars b on b.trade_date = r.signal_date
        where b.entry_open is not null
      )
      select
        signal_date,
        count(ret5)::int as ret5_count,
        avg(ret5) as ret5_avg,
        percentile_cont(0.5) within group (order by ret5) filter (where ret5 is not null) as ret5_median,
        avg(case when ret5 > 0 then 1.0 else 0.0 end) filter (where ret5 is not null) as ret5_win_rate,
        avg(ret5) filter (where ret5 > 0) as ret5_avg_win,
        avg(ret5) filter (where ret5 < 0) as ret5_avg_loss,
        coalesce(sum(ret5) filter (where ret5 > 0), 0) as ret5_gain,
        abs(coalesce(sum(ret5) filter (where ret5 < 0), 0)) as ret5_loss,
        max(ret5) as ret5_best,
        min(ret5) as ret5_worst,
        count(ret10)::int as ret10_count,
        avg(ret10) as ret10_avg,
        percentile_cont(0.5) within group (order by ret10) filter (where ret10 is not null) as ret10_median,
        avg(case when ret10 > 0 then 1.0 else 0.0 end) filter (where ret10 is not null) as ret10_win_rate,
        avg(ret10) filter (where ret10 > 0) as ret10_avg_win,
        avg(ret10) filter (where ret10 < 0) as ret10_avg_loss,
        coalesce(sum(ret10) filter (where ret10 > 0), 0) as ret10_gain,
        abs(coalesce(sum(ret10) filter (where ret10 < 0), 0)) as ret10_loss,
        max(ret10) as ret10_best,
        min(ret10) as ret10_worst,
        count(ret20)::int as ret20_count,
        avg(ret20) as ret20_avg,
        percentile_cont(0.5) within group (order by ret20) filter (where ret20 is not null) as ret20_median,
        avg(case when ret20 > 0 then 1.0 else 0.0 end) filter (where ret20 is not null) as ret20_win_rate,
        avg(ret20) filter (where ret20 > 0) as ret20_avg_win,
        avg(ret20) filter (where ret20 < 0) as ret20_avg_loss,
        coalesce(sum(ret20) filter (where ret20 > 0), 0) as ret20_gain,
        abs(coalesce(sum(ret20) filter (where ret20 < 0), 0)) as ret20_loss,
        max(ret20) as ret20_best,
        min(ret20) as ret20_worst
      from returns
      group by signal_date
      order by signal_date asc
    `,
    params,
  );

  const stats = new Map();
  for (const row of rows) {
    const date = normalizeDate(row.signal_date);
    if (!date) continue;
    stats.set(date, {
      ret5: dbMarketStatsForRow(row, "ret5"),
      ret10: dbMarketStatsForRow(row, "ret10"),
      ret20: dbMarketStatsForRow(row, "ret20"),
    });
  }
  return stats;
}

async function marketDailyStats(dates) {
  if (!dates.length) return new Map();
  if (process.env.DATABASE_URL) {
    try {
      const baselineStats = await marketDailyStatsFromBaselineTable(dates);
      if (baselineStats.size) return baselineStats;
    } catch (error) {
      console.warn(`Market baseline table query failed: ${error.message}`);
    }
    try {
      const dbStats = await marketDailyStatsFromDb(dates);
      if (dbStats.size) return dbStats;
    } catch (error) {
      console.warn(`Market baseline DB query failed: ${error.message}`);
    }
  }
  return marketDailyStatsFromLocal(dates);
}

function expectedBaselineHorizon(events, marketStats, field, label) {
  const byDate = new Map();
  for (const event of events) {
    if (!Number.isFinite(event[field])) continue;
    if (!byDate.has(event.signalDate)) byDate.set(event.signalDate, 0);
    byDate.set(event.signalDate, byDate.get(event.signalDate) + 1);
  }

  let avgNumerator = 0;
  let medianNumerator = 0;
  let winNumerator = 0;
  let profitFactorNumerator = 0;
  let payoffNumerator = 0;
  let best = null;
  let worst = null;
  let weight = 0;
  for (const [date, count] of byDate.entries()) {
    const stats = marketStats.get(date)?.[field];
    if (!stats || !Number.isFinite(stats.avg) || !Number.isFinite(stats.winRate)) continue;
    avgNumerator += stats.avg * count;
    if (Number.isFinite(stats.median)) medianNumerator += stats.median * count;
    winNumerator += stats.winRate * count;
    if (Number.isFinite(stats.profitFactor)) profitFactorNumerator += stats.profitFactor * count;
    if (Number.isFinite(stats.payoffRatio)) payoffNumerator += stats.payoffRatio * count;
    if (Number.isFinite(stats.best)) best = best === null ? stats.best : Math.max(best, stats.best);
    if (Number.isFinite(stats.worst)) worst = worst === null ? stats.worst : Math.min(worst, stats.worst);
    weight += count;
  }

  return {
    key: field,
    label,
    sampleCount: events.length,
    maturedCount: weight,
    pendingCount: events.length - weight,
    coverage: events.length ? weight / events.length : null,
    avg: weight ? avgNumerator / weight : null,
    median: weight ? medianNumerator / weight : null,
    winRate: weight ? winNumerator / weight : null,
    avgWin: null,
    avgLoss: null,
    payoffRatio: weight ? payoffNumerator / weight : null,
    profitFactor: weight ? profitFactorNumerator / weight : null,
    best,
    worst,
  };
}

function eventHorizonReturn(event, field = "ret20") {
  return Number.isFinite(event[field]) ? event[field] : null;
}

function marketReturnForEvent(event, marketStats, field = "ret20") {
  const value = marketStats.get(event.signalDate)?.[field]?.avg;
  return Number.isFinite(value) ? value : null;
}

function daySignalCounts(events) {
  const counts = new Map();
  for (const event of events) counts.set(event.signalDate, (counts.get(event.signalDate) || 0) + 1);
  return counts;
}

function enrichedEventsForAttribution(events, marketStats) {
  const counts = daySignalCounts(events);
  return events.map((event) =>
    applySignalQuality(
      { ...event },
      {
        daySignalCount: counts.get(event.signalDate) || 0,
        marketRet20: marketReturnForEvent(event, marketStats, "ret20"),
      },
    ),
  );
}

function groupStats(events, marketStats, field = "ret20") {
  const matured = events.filter((event) => Number.isFinite(eventHorizonReturn(event, field)));
  const values = matured.map((event) => eventHorizonReturn(event, field));
  const excessValues = matured
    .map((event) => {
      const market = marketReturnForEvent(event, marketStats, field);
      const ret = eventHorizonReturn(event, field);
      return Number.isFinite(ret) && Number.isFinite(market) ? ret - market : null;
    })
    .filter(Number.isFinite);
  return {
    count: events.length,
    maturedCount: matured.length,
    avg: avg(values),
    median: median(values),
    winRate: winRate(values),
    failureRate: values.length ? values.filter((value) => value < 0).length / values.length : null,
    marketExcessAvg: avg(excessValues),
    marketUnderperformRate: excessValues.length ? excessValues.filter((value) => value < 0).length / excessValues.length : null,
  };
}

function attributionGroupRows(events, marketStats, getKey, getLabel, field = "ret20") {
  const groups = new Map();
  for (const event of events) {
    const key = getKey(event);
    if (!groups.has(key)) groups.set(key, { key, label: getLabel ? getLabel(event, key) : key, events: [] });
    groups.get(key).events.push(event);
  }
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      label: group.label,
      ...groupStats(group.events, marketStats, field),
    }))
    .sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)));
}

function buildTagStats(events, marketStats) {
  const groups = new Map();
  for (const event of events) {
    const tags = event.riskTags?.length ? event.riskTags : ["无明显标签"];
    for (const tag of tags) {
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push(event);
    }
  }
  return [...groups.entries()]
    .map(([tag, items]) => ({
      tag,
      ...groupStats(items, marketStats, "ret20"),
    }))
    .sort((a, b) => b.count - a.count || (b.failureRate || 0) - (a.failureRate || 0));
}

function buildAttributionHypotheses(tagStats, overall) {
  const minCount = 3;
  const baseFailure = overall.failureRate || 0;
  const baseUnderperform = overall.marketUnderperformRate || 0;
  return tagStats
    .filter((row) => row.count >= minCount)
    .map((row) => {
      const failureLift = Number.isFinite(row.failureRate) ? row.failureRate - baseFailure : null;
      const underperformLift = Number.isFinite(row.marketUnderperformRate) ? row.marketUnderperformRate - baseUnderperform : null;
      const riskLift = Math.max(failureLift || 0, underperformLift || 0);
      const action =
        riskLift >= 0.15
          ? "建议降权观察"
          : riskLift >= 0.08
            ? "继续跟踪验证"
            : row.marketExcessAvg !== null && row.marketExcessAvg < 0
              ? "保留为风险提示"
              : "暂不调整";
      return {
        tag: row.tag,
        count: row.count,
        failureRate: row.failureRate,
        marketUnderperformRate: row.marketUnderperformRate,
        marketExcessAvg: row.marketExcessAvg,
        failureLift,
        underperformLift,
        action,
      };
    })
    .filter((row) => row.action !== "暂不调整")
    .sort((a, b) => Math.max(b.failureLift || 0, b.underperformLift || 0) - Math.max(a.failureLift || 0, a.underperformLift || 0))
    .slice(0, 8);
}

function buildSelfAttribution(events, marketStats) {
  const enriched = enrichedEventsForAttribution(events, marketStats);
  const matured = enriched.filter((event) => Number.isFinite(event.ret20));
  const absoluteFailures = matured.filter((event) => event.ret20 < 0);
  const weakPositives = matured.filter((event) => event.ret20 >= 0 && event.ret20 < 0.05);
  const marketUnderperformers = matured.filter((event) => {
    const market = marketReturnForEvent(event, marketStats, "ret20");
    return Number.isFinite(market) && event.ret20 < market;
  });
  const overall = groupStats(enriched, marketStats, "ret20");
  const tagStats = buildTagStats(enriched, marketStats);
  const strengthBands = attributionGroupRows(
    enriched,
    marketStats,
    (event) => event.signalStrength?.band || "unknown",
    (event) => event.signalStrength?.label || "未评分",
  );
  const dayCountGroups = attributionGroupRows(
    enriched,
    marketStats,
    (event) => (event.daySignalCount === 1 ? "single" : "multi"),
    (event) => (event.daySignalCount === 1 ? "单信号日" : "多信号日"),
  );
  const boardHotGroups = attributionGroupRows(
    enriched,
    marketStats,
    (event) => {
      if (!Number.isFinite(event.boardHotRatio)) return "unknown";
      if (event.boardHotRatio < 0.65) return "lt65";
      if (event.boardHotRatio < 0.8) return "65-80";
      if (event.boardHotRatio < 0.9) return "80-90";
      return "gte90";
    },
    (_, key) => ({ lt65: "板块热度<65%", "65-80": "板块热度65%-80%", "80-90": "板块热度80%-90%", gte90: "板块热度≥90%" })[key] || "未知热度",
  );
  const failureCases = absoluteFailures
    .slice()
    .sort((a, b) => a.ret20 - b.ret20)
    .slice(0, 12)
    .map((event) => {
      const marketRet20 = marketReturnForEvent(event, marketStats, "ret20");
      return {
        signalDate: event.signalDate,
        code: event.code,
        name: event.name,
        ret5: event.ret5,
        ret10: event.ret10,
        ret20: event.ret20,
        marketRet20,
        excessRet20: Number.isFinite(marketRet20) ? event.ret20 - marketRet20 : null,
        rank: event.rank,
        prev5: event.prev5,
        relativeRet5: event.relativeRet5,
        amountRatio: event.amountRatio,
        bestBoardName: event.bestBoardName,
        bestBoardRet5: event.bestBoardRet5,
        bestBoardAmountRatio: event.bestBoardAmountRatio,
        boardHotRatio: event.boardHotRatio,
        boardLeaderPct: event.boardLeaderPct,
        attributionType: event.attributionType,
        signalStrength: event.signalStrength,
        riskTags: event.riskTags || [],
      };
    });

  return {
    definition: "20日收益<0 为绝对失败；20日收益跑输同日全市场随机基准为相对失败。",
    overall,
    counts: {
      sampleCount: enriched.length,
      matured20: matured.length,
      absoluteFailureCount: absoluteFailures.length,
      weakPositiveCount: weakPositives.length,
      marketUnderperformCount: marketUnderperformers.length,
    },
    strengthBands,
    tagStats,
    dayCountGroups,
    boardHotGroups,
    hypotheses: buildAttributionHypotheses(tagStats, overall),
    failureCases,
  };
}

function dateFilteredEvents(events, from, to) {
  const start = normalizeDate(from);
  const end = normalizeDate(to);
  return events.filter((event) => (!start || event.signalDate >= start) && (!end || event.signalDate <= end));
}

function displayDateRange(signalDates, requestedDate = null) {
  const calendar = readTradingCalendar();
  if (!calendar.length) return signalDates;
  const normalizedRequest = normalizeDate(requestedDate);
  const start = signalDates[0] || normalizedRequest || calendar[0];
  const endCandidates = [signalDates[signalDates.length - 1], normalizedRequest, calendar[calendar.length - 1]].filter(Boolean);
  const end = endCandidates.sort().at(-1);
  return calendar.filter((date) => date >= start && date <= end);
}

async function availableStrategiesForSource(sourceKey) {
  const customConfigs = await listStrategyConfigs(sourceKey);
  return {
    builtIn: Object.values(STRATEGIES).map((strategy) => builtinStrategyDescriptor(strategy.key)),
    custom: customConfigs.map(customStrategyDescriptor),
    customConfigs,
  };
}

function summarizeSignals(events) {
  const first = events.filter((event) => event.signalInsight?.isFirstSignal).length;
  const continuation = events.filter((event) => event.signalInsight?.isContinuation).length;
  const waitForConfirm = events.filter((event) => event.signalInsight?.waitForConfirm).length;
  const accelerated = events.filter((event) => event.signalInsight?.stockAccelerated).length;
  const boardHot = events.filter((event) => event.signalInsight?.boardHot).length;
  const confirmed = events.filter((event) => event.signalInsight?.secondary?.status === "已二次确认").length;
  const direct = events.filter((event) => event.signalInsight?.secondary?.status === "直接走强").length;
  return {
    first,
    continuation,
    waitForConfirm,
    accelerated,
    boardHot,
    confirmed,
    direct,
  };
}

function aggregateBoards(events) {
  const map = new Map();
  for (const event of events) {
    const key = `${event.bestBoardType}:${event.bestBoardCode}:${event.bestBoardName}`;
    if (!map.has(key)) {
      map.set(key, {
        type: event.bestBoardType,
        code: event.bestBoardCode,
        name: event.bestBoardName,
        stockCount: 0,
        stocks: [],
        boardRet5: event.bestBoardRet5,
        boardRet10: event.bestBoardRet10,
        boardAmountRatio: event.bestBoardAmountRatio,
        avgStockScore: null,
        avgRet5: null,
        avgRet10: null,
        avgRet20: null,
      });
    }
    const board = map.get(key);
    board.stockCount += 1;
    board.stocks.push({ code: event.code, name: event.name, score: event.score });
  }

  return [...map.values()]
    .map((board) => {
      const boardEvents = events.filter(
        (event) =>
          event.bestBoardCode === board.code && event.bestBoardType === board.type && event.bestBoardName === board.name,
      );
      return {
        ...board,
        avgStockScore: avg(boardEvents.map((event) => event.score)),
        avgRet5: avg(boardEvents.map((event) => event.ret5)),
        avgRet10: avg(boardEvents.map((event) => event.ret10)),
        avgRet20: avg(boardEvents.map((event) => event.ret20)),
      };
    })
    .sort((a, b) => b.stockCount - a.stockCount || (b.avgStockScore || 0) - (a.avgStockScore || 0));
}

function findNearestDate(dates, requested) {
  if (!requested || dates.includes(requested)) return requested || dates[dates.length - 1] || null;
  const earlier = dates.filter((date) => date <= requested);
  return earlier[earlier.length - 1] || dates[0] || null;
}

function previousDate(dates, requested, inclusive = false) {
  if (!requested) return null;
  const earlier = dates.filter((date) => (inclusive ? date <= requested : date < requested));
  return earlier[earlier.length - 1] || null;
}

function nextAvailableDate(dates, requested) {
  if (!requested) return null;
  return dates.find((date) => date > requested) || null;
}

function dateStatus(requestedDate, selectedDate, tradingDates, signalDates) {
  const hasCalendar = tradingDates.length > 0;
  const isTradingDate = !requestedDate || !hasCalendar ? true : tradingDates.includes(requestedDate);
  return {
    requestedDate,
    selectedDate,
    isTradingDate,
    hasSignal: selectedDate ? signalDates.includes(selectedDate) : false,
    previousTradingDate: requestedDate && hasCalendar ? previousDate(tradingDates, requestedDate) : null,
    nextTradingDate: requestedDate && hasCalendar ? nextAvailableDate(tradingDates, requestedDate) : null,
    previousSignalDate: requestedDate ? previousDate(signalDates, requestedDate) : null,
    nextSignalDate: requestedDate ? nextAvailableDate(signalDates, requestedDate) : null,
  };
}

async function dailyPayload(query) {
  const data = await loadDataForSource(query.source, query.strategy);
  const strict = query.strict !== "false";
  const signalDates = strict ? data.dates : data.allDates;
  const map = strict ? data.byDate : data.allByDate;
  const requestedDate = normalizeDate(query.date) || signalDates[signalDates.length - 1] || null;
  const tradingDates = displayDateRange(signalDates, requestedDate);
  const isTradingDate = !requestedDate || !tradingDates.length || tradingDates.includes(requestedDate);
  const selectedDate = !requestedDate
    ? tradingDates[tradingDates.length - 1] || signalDates[signalDates.length - 1] || null
    : isTradingDate
      ? requestedDate
      : previousDate(tradingDates, requestedDate) || nextAvailableDate(tradingDates, requestedDate) || requestedDate;
  const exactDate = !query.date || normalizeDate(query.date) === selectedDate;
  const events = selectedDate ? [...(map.get(selectedDate) || [])].sort((a, b) => b.sortScore - a.sortScore) : [];
  const displayEvents = events.map((event) => applySignalQuality({ ...event }, { daySignalCount: events.length }));
  return {
    selectedDate,
    requestedDate: query.date || null,
    exactDate,
    nextAvailableDate: exactDate ? null : nextAvailableDate(tradingDates, query.date),
    strict,
    availableDates: tradingDates,
    signalDates,
    tradingDates,
    dateStatus: dateStatus(query.date || null, selectedDate, tradingDates, signalDates),
    source: data.dataSource.description,
    dataSource: data.dataSource,
    dataStrategy: data.dataSource.strategy,
    rule: data.dataSource.strategy?.rule || STRATEGIES.early.rule,
    stats: summarize(displayEvents),
    signalStats: summarizeSignals(displayEvents),
    boards: aggregateBoards(displayEvents),
    stocks: displayEvents,
  };
}

async function timelinePayload(query) {
  const data = await loadDataForSource(query.source, query.strategy);
  const strict = query.strict !== "false";
  const signalDates = strict ? data.dates : data.allDates;
  const dates = displayDateRange(signalDates, query.date);
  const map = strict ? data.byDate : data.allByDate;
  return dates.map((date) => {
    const events = map.get(date) || [];
    return {
      date,
      ...summarize(events),
      boardCount: aggregateBoards(events).length,
      topBoards: aggregateBoards(events).slice(0, 3).map((board) => board.name),
    };
  });
}

async function overviewPayload(query = {}) {
  const data = await loadDataForSource(query.source, query.strategy);
  const strategies = await availableStrategiesForSource(data.sourceKey);
  const tradingDates = readTradingCalendar().filter(
    (date) => date >= (data.dates[0] || date) && date <= (data.dates[data.dates.length - 1] || date),
  );
  return {
    generatedAt: data.generatedAt,
    sourceFile: data.sourceFile,
    sourceKey: data.sourceKey,
    dataSource: data.dataSource,
    availableSources: Object.values(DATA_SOURCES),
    availableStrategies: [...strategies.builtIn, ...strategies.custom],
    customStrategies: strategies.custom,
    strategyParamDefs: STRATEGY_PARAM_DEFS,
    dataStrategy: data.dataSource.strategy,
    strictCount: data.strictEvents.length,
    rawCount: data.events.length,
    dateCount: data.dates.length,
    minDate: data.dates[0] || null,
    maxDate: data.dates[data.dates.length - 1] || null,
    tradingDateCount: tradingDates.length,
    tradingMinDate: tradingDates[0] || null,
    tradingMaxDate: tradingDates[tradingDates.length - 1] || null,
    overall: summarize(data.strictEvents),
  };
}

async function strategyConfigsPayload(query = {}) {
  const sourceKey = normalizeSourceKey(query.source);
  const strategies = await availableStrategiesForSource(sourceKey);
  return {
    sourceKey,
    builtIn: strategies.builtIn,
    custom: strategies.custom,
    configs: strategies.customConfigs,
    paramDefs: STRATEGY_PARAM_DEFS,
    defaults: STRATEGY_PARAM_DEFAULTS,
  };
}

async function evaluationPayload(query = {}) {
  const data = await loadDataForSource(query.source, query.strategy);
  const strict = query.strict !== "false";
  const baseEvents = strict ? data.strictEvents : data.events;
  const events = dateFilteredEvents(baseEvents, query.from, query.to);
  const dates = [...new Set(events.map((event) => event.signalDate))].sort();
  const marketStats = await marketDailyStats(dates);
  const strategyHorizons = [
    horizonEvaluation(events, "ret5", "5日"),
    horizonEvaluation(events, "ret10", "10日"),
    horizonEvaluation(events, "ret20", "20日"),
  ];
  const baselineHorizons = [
    expectedBaselineHorizon(events, marketStats, "ret5", "5日"),
    expectedBaselineHorizon(events, marketStats, "ret10", "10日"),
    expectedBaselineHorizon(events, marketStats, "ret20", "20日"),
  ];
  const horizons = strategyHorizons.map((item, index) => attachBaselineToHorizon(item, baselineHorizons[index]));
  const dailyRet5 = dailyEvaluation(events, "ret5");
  const dailyRet20 = dailyEvaluation(events, "ret20");
  const rankDeltas = events
    .map((event) => (event.rank20 && event.rank ? event.rank20 - event.rank : null))
    .filter(Number.isFinite);
  const amountRatios = events.map((event) => event.amountRatio).filter(Number.isFinite);
  const boardRet5 = events.map((event) => event.bestBoardRet5).filter(Number.isFinite);
  const selfAttribution = buildSelfAttribution(events, marketStats);

  return {
    strict,
    requestedRange: {
      from: normalizeDate(query.from) || null,
      to: normalizeDate(query.to) || null,
    },
    actualRange: {
      from: dates[0] || null,
      to: dates[dates.length - 1] || null,
    },
    dataSource: data.dataSource,
    dataStrategy: data.dataSource.strategy,
    sampleCount: events.length,
    dateCount: dates.length,
    avgCandidatesPerDate: dates.length ? events.length / dates.length : null,
    baseline: {
      available: marketStats.size > 0,
      method: marketStats.size ? "same-date full-market expected random A-share basket" : "unavailable",
      sampleCount: baselineHorizons[0]?.maturedCount || 0,
      dateCount: marketStats.size,
    },
    horizons,
    featureStats: {
      avgRankDelta20: avg(rankDeltas),
      medianRankDelta20: median(rankDeltas),
      avgAmountRatio: avg(amountRatios),
      medianAmountRatio: median(amountRatios),
      avgBoardRet5: avg(boardRet5),
      medianBoardRet5: median(boardRet5),
    },
    daily: {
      ret5: dailyRet5,
      ret20: dailyRet20,
      best5: dailyRet5.slice().sort((a, b) => (b.avg || 0) - (a.avg || 0)).slice(0, 5),
      worst5: dailyRet5.slice().sort((a, b) => (a.avg || 0) - (b.avg || 0)).slice(0, 5),
      best20: dailyRet20.slice().sort((a, b) => (b.avg || 0) - (a.avg || 0)).slice(0, 5),
      worst20: dailyRet20.slice().sort((a, b) => (a.avg || 0) - (b.avg || 0)).slice(0, 5),
    },
    selfAttribution,
  };
}

async function stockSignalsPayload(query = {}) {
  const data = await loadDataForSource(query.source, query.strategy);
  const strict = query.strict !== "false";
  const rawQuery = String(query.code || query.q || "").trim();
  const code = rawQuery.match(/\d{6}/)?.[0] || "";
  const nameNeedle = rawQuery.toLowerCase();
  const events = strict ? data.strictEvents : data.events;
  const matches = rawQuery
    ? events
        .filter((event) => {
          if (code) return event.code === code;
          return String(event.name || "").toLowerCase().includes(nameNeedle);
        })
        .sort((a, b) => b.signalDate.localeCompare(a.signalDate) || b.sortScore - a.sortScore)
    : [];
  const chronological = [...matches].sort((a, b) => a.signalDate.localeCompare(b.signalDate));
  const dates = [...new Set(chronological.map((event) => event.signalDate))];
  const dayCounts = daySignalCounts(events);
  return {
    query: rawQuery,
    code: code || null,
    strict,
    dataSource: data.dataSource,
    count: matches.length,
    signalDateCount: dates.length,
    firstDate: dates[0] || null,
    latestDate: dates[dates.length - 1] || null,
    stats: summarize(matches),
    matches: matches.map((event) => {
      const displayEvent = applySignalQuality({ ...event }, { daySignalCount: dayCounts.get(event.signalDate) || 0 });
      return {
      signalDate: event.signalDate,
      em: event.em,
      code: event.code,
      name: event.name,
      source: event.source,
      rank: event.rank,
      rank20: event.rank20,
      rankDelta: event.rank20 && event.rank ? event.rank20 - event.rank : null,
      amountRatio: event.amountRatio,
      bestBoardType: event.bestBoardType,
      bestBoardName: event.bestBoardName,
      bestBoardRet5: event.bestBoardRet5,
      relativeRet5: event.relativeRet5,
      attributionType: event.attributionType,
      ret5: event.ret5,
      ret10: event.ret10,
      ret20: event.ret20,
      score: event.score,
      modelScore: event.modelScore,
      riskFlags: event.riskFlags || [],
      riskTags: displayEvent.riskTags || [],
      signalStrength: displayEvent.signalStrength,
      meta: event.meta,
      signalInsight: event.signalInsight,
      };
    }),
    message: !rawQuery
      ? "请输入股票代码或名称。"
      : matches.length
        ? ""
        : data.dataSource.available === false
          ? data.dataSource.message
          : "当前数据源和过滤条件下，没有查到这只股票的策略信号。",
  };
}

function normalizeStock(input) {
  const raw = String(input || "").trim().toUpperCase();
  const code = raw.match(/\d{6}/)?.[0] || "";
  if (!code) throw new Error("请输入 6 位股票代码");
  const market = raw.startsWith("SH") || code.startsWith("6") ? "SH" : "SZ";
  const marketId = market === "SH" ? "1" : "0";
  return {
    code,
    market,
    em: `${market}${code}`,
    secid: `${marketId}.${code}`,
    cacheFile: path.join(KLINE_DIR, `${marketId}.${code}.json`),
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = KLINE_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchKline(stock) {
  const url =
    "https://push2his.eastmoney.com/api/qt/stock/kline/get" +
    `?secid=${stock.secid}` +
    "&fields1=f1,f2,f3,f4,f5,f6" +
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61" +
    "&klt=101&fqt=1&beg=20200101&end=20500101&lmt=1000000";
  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://quote.eastmoney.com/",
    },
  });
  if (!response.ok) throw new Error(`K线请求失败：${response.status}`);
  const json = await response.json();
  const rows = (json.data?.klines || []).map(parseKlineLine).filter(Boolean);
  if (!rows.length) throw new Error(`没有找到 ${stock.code} 的日 K 数据`);
  try {
    fs.mkdirSync(KLINE_DIR, { recursive: true });
    fs.writeFileSync(stock.cacheFile, JSON.stringify(rows));
  } catch {
    // Serverless deployments may not have a writable project directory.
  }
  if (shouldUseDatabase("em")) {
    await saveKlineToDb(stock, rows);
  }
  return rows;
}

function parseKlineLine(line) {
  const parts = String(line || "").split(",");
  if (parts.length < 11) return null;
  return {
    date: parts[0],
    open: Number(parts[1]),
    close: Number(parts[2]),
    high: Number(parts[3]),
    low: Number(parts[4]),
    volume: Number(parts[5]),
    amount: Number(parts[6]),
    amplitude: Number(parts[7]),
    pct: Number(parts[8]),
    change: Number(parts[9]),
    turnover: Number(parts[10]),
  };
}

async function loadKline(stock) {
  if (shouldUseDatabase("em")) {
    const rows = await loadKlineFromDb(stock);
    if (rows.length) return rows;
  }
  if (fs.existsSync(stock.cacheFile)) {
    const rows = JSON.parse(fs.readFileSync(stock.cacheFile, "utf8"));
    if (Array.isArray(rows) && rows.length) {
      if (shouldUseDatabase("em")) await saveKlineToDb(stock, rows);
      return rows;
    }
  }
  return fetchKline(stock);
}

function marketIndexCacheFile(index = MARKET_INDEX) {
  return path.join(KLINE_DIR, `index-${index.secid}.json`);
}

async function fetchMarketIndexKline(index = MARKET_INDEX) {
  const url =
    "https://push2his.eastmoney.com/api/qt/stock/kline/get" +
    `?secid=${index.secid}` +
    "&fields1=f1,f2,f3,f4,f5,f6" +
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61" +
    "&klt=101&fqt=1&beg=20200101&end=20500101&lmt=1000000";
  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://quote.eastmoney.com/",
    },
  });
  if (!response.ok) throw new Error(`${index.name} K线请求失败：${response.status}`);
  const json = await response.json();
  const rows = (json.data?.klines || []).map(parseKlineLine).filter(Boolean);
  if (!rows.length) throw new Error(`没有找到 ${index.name} 的日 K 数据`);
  try {
    fs.mkdirSync(KLINE_DIR, { recursive: true });
    fs.writeFileSync(marketIndexCacheFile(index), JSON.stringify(rows));
  } catch {
    // Serverless deployments may not have a writable project directory.
  }
  return rows;
}

async function loadMarketIndexKline(index = MARKET_INDEX) {
  const file = marketIndexCacheFile(index);
  if (fs.existsSync(file)) {
    try {
      const rows = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(rows) && rows.length) return rows.filter((row) => row.date && Number.isFinite(row.open) && Number.isFinite(row.close));
    } catch {
      // Ignore a broken local cache and fetch a fresh copy.
    }
  }
  return fetchMarketIndexKline(index);
}

async function loadKlineFromDb(stock) {
  const { rows } = await getDbPool().query(
    `
      select trade_date, open, close, high, low, volume, amount, amplitude, pct, change, turnover
      from stock_daily_bars
      where code = $1
      order by trade_date asc
    `,
    [stock.code],
  );
  return rows
    .map((row) => ({
      date: normalizeDate(row.trade_date),
      open: n(row.open),
      close: n(row.close),
      high: n(row.high),
      low: n(row.low),
      volume: n(row.volume),
      amount: n(row.amount),
      amplitude: n(row.amplitude),
      pct: n(row.pct),
      change: n(row.change),
      turnover: n(row.turnover),
    }))
    .filter((row) => row.date && Number.isFinite(row.open) && Number.isFinite(row.close));
}

async function saveKlineToDb(stock, rows) {
  const cleanRows = rows
    .filter((row) => row.date >= KLINE_DB_START_DATE && Number.isFinite(row.open) && Number.isFinite(row.close))
    .map((row) => ({
      code: stock.code,
      trade_date: row.date,
      market: stock.market,
      open: row.open,
      close: row.close,
      high: row.high,
      low: row.low,
      volume: row.volume,
      amount: row.amount,
      amplitude: row.amplitude,
      pct: row.pct,
      change: row.change,
      turnover: row.turnover,
    }));
  if (!cleanRows.length) return;

  const pool = getDbPool();
  await pool.query(
    "insert into stocks (code, name, exchange, updated_at) values ($1, $2, $3, now()) on conflict (code) do nothing",
    [stock.code, stock.code, stock.market],
  );

  for (let index = 0; index < cleanRows.length; index += 5000) {
    const chunk = cleanRows.slice(index, index + 5000);
    await pool.query(
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

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function getHeader(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() !== target) continue;
    return Array.isArray(value) ? value[0] || "" : String(value || "");
  }
  return "";
}

function assertCronAuthorized(query = {}, headers = {}) {
  const secret = process.env.CRON_SECRET;
  const isHostedRuntime = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
  if (!secret) {
    if (isHostedRuntime) {
      const error = new Error("CRON_SECRET is required for hosted daily sync");
      error.statusCode = 500;
      throw error;
    }
    return { required: false };
  }

  const authorization = getHeader(headers, "authorization");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const provided = bearer || getHeader(headers, "x-cron-secret") || String(query.secret || "");
  if (provided !== secret) {
    const error = new Error("Unauthorized");
    error.statusCode = 401;
    throw error;
  }
  return { required: true };
}

function requireDatabase() {
  if (process.env.DATABASE_URL) return;
  const error = new Error("DATABASE_URL is required for daily sync");
  error.statusCode = 500;
  throw error;
}

async function createSyncRun(jobName, details) {
  const { rows } = await getDbPool().query(
    `
      insert into sync_runs (job_name, status, details)
      values ($1, 'running', $2::jsonb)
      returning id, started_at
    `,
    [jobName, JSON.stringify(details || {})],
  );
  return rows[0];
}

async function finishSyncRun(runId, status, summary, errorMessage = null) {
  await getDbPool().query(
    `
      update sync_runs
      set
        status = $2,
        finished_at = now(),
        selected_count = $3,
        success_count = $4,
        failed_count = $5,
        details = $6::jsonb,
        error = $7
      where id = $1
    `,
    [
      runId,
      status,
      summary.selectedCount || 0,
      summary.successCount || 0,
      summary.failedCount || 0,
      JSON.stringify(summary),
      errorMessage,
    ],
  );
}

async function selectDailySyncStocks({ sourceKey, strategyKey, lookbackDays, maxStocks, force }) {
  const { rows } = await getDbPool().query(
    `
      with bounds as (
        select coalesce(max(signal_date), current_date) as max_signal_date
        from strategy_signals
        where source = $3
          and ($4::text is null or strategy = $4)
      ),
      recent_signals as (
        select
          s.code,
          max(s.name) as name,
          max(s.signal_date) as latest_signal_date,
          count(*)::int as signal_count
        from strategy_signals s
        cross join bounds b
        where s.source = $3
          and ($4::text is null or s.strategy = $4)
          and s.signal_date >= b.max_signal_date - ($1::int * interval '1 day')
        group by s.code
      ),
      latest_bars as (
        select
          code,
          max(trade_date) as latest_bar_date,
          max(updated_at) as latest_bar_updated_at
        from stock_daily_bars
        group by code
      )
      select
        rs.code,
        rs.name,
        rs.latest_signal_date,
        rs.signal_count,
        lb.latest_bar_date,
        lb.latest_bar_updated_at
      from recent_signals rs
      left join latest_bars lb on lb.code = rs.code
      where $5::boolean
         or lb.latest_bar_updated_at is null
         or lb.latest_bar_updated_at < now() - interval '18 hours'
      order by lb.latest_bar_updated_at asc nulls first, rs.latest_signal_date desc, rs.signal_count desc
      limit $2::int
    `,
    [lookbackDays, maxStocks, sourceKey, strategyKey || null, Boolean(force)],
  );

  return rows.map((row) => ({
    code: row.code,
    name: row.name || row.code,
    latestSignalDate: normalizeDate(row.latest_signal_date),
    signalCount: n(row.signal_count) || 0,
    latestBarDate: normalizeDate(row.latest_bar_date),
    latestBarUpdatedAt: row.latest_bar_updated_at ? new Date(row.latest_bar_updated_at).toISOString() : null,
  }));
}

async function runDailyKlineSync(options = {}) {
  requireDatabase();
  const sourceKey = normalizeSourceKey(options.source || "em");
  if (sourceKey !== "em") {
    const error = new Error("当前自动同步只支持东方财富数据源");
    error.statusCode = 400;
    throw error;
  }

  const strategyKey = options.strategy && STRATEGIES[options.strategy] ? options.strategy : null;
  const lookbackDays = boundedInteger(
    options.lookbackDays ?? process.env.SYNC_LOOKBACK_DAYS,
    DEFAULT_SYNC_LOOKBACK_DAYS,
    1,
    365,
  );
  const maxStocks = boundedInteger(
    options.maxStocks ?? process.env.SYNC_MAX_STOCKS,
    DEFAULT_SYNC_MAX_STOCKS,
    1,
    200,
  );
  const force = options.force === true || options.force === "1" || options.force === "true";
  const params = { sourceKey, strategyKey, lookbackDays, maxStocks, force };
  const startedAt = new Date().toISOString();
  const run = await createSyncRun(DAILY_SYNC_JOB, { params, startedAt });
  const results = [];

  try {
    const candidates = await selectDailySyncStocks(params);
    let successCount = 0;
    let failedCount = 0;

    for (const candidate of candidates) {
      const stock = normalizeStock(candidate.code);
      const item = {
        code: candidate.code,
        name: candidate.name,
        latestSignalDate: candidate.latestSignalDate,
        previousLatestBarDate: candidate.latestBarDate,
        status: "pending",
      };
      try {
        const rows = await fetchKline(stock);
        const latestRow = rows[rows.length - 1] || null;
        item.status = "synced";
        item.rowCount = rows.length;
        item.latestBarDate = latestRow?.date || null;
        successCount += 1;
      } catch (error) {
        item.status = "failed";
        item.error = error.message;
        failedCount += 1;
      }
      results.push(item);
    }

    const summary = {
      jobName: DAILY_SYNC_JOB,
      runId: run.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      params,
      selectedCount: candidates.length,
      successCount,
      failedCount,
      results,
    };
    const status = failedCount ? (successCount ? "partial" : "failed") : "success";
    await finishSyncRun(run.id, status, summary, failedCount && !successCount ? "all selected stocks failed" : null);
    cachedDbData.clear();
    return { ...summary, status };
  } catch (error) {
    const summary = {
      jobName: DAILY_SYNC_JOB,
      runId: run.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      params,
      selectedCount: results.length,
      successCount: results.filter((item) => item.status === "synced").length,
      failedCount: results.filter((item) => item.status === "failed").length,
      results,
    };
    await finishSyncRun(run.id, "failed", summary, error.message);
    throw error;
  }
}

async function dailySyncPayload(query = {}, headers = {}) {
  assertCronAuthorized(query, headers);
  return runDailyKlineSync({
    source: query.source,
    strategy: query.strategy,
    lookbackDays: query.lookbackDays,
    maxStocks: query.maxStocks,
    force: query.force,
  });
}

function thsConceptTag(item) {
  const tag = item?.tag || {};
  const conceptTag = tag.concept_tag;
  if (Array.isArray(conceptTag) && conceptTag.length >= 3) return String(conceptTag[2] || "");
  return "";
}

function isAStockCode(code, market) {
  if (!/^[036]\d{5}$/.test(String(code || ""))) return false;
  return !market || ["17", "33"].includes(String(market));
}

function thsHistoryRecordsFromPayload(payload, requestedYmd, category) {
  const data = payload?.data || {};
  const listMap = data.stock_list || data.plate_list || {};
  const records = [];
  for (const [timeKey, items] of Object.entries(listMap)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const code = String(item.code || "");
      const market = String(item.market || item.market_id || "");
      if (category === "stock" && !isAStockCode(code, market)) continue;
      const itemTimeKey = String(item.time || timeKey || "");
      const snapshotYmd = /^\d{12}$/.test(itemTimeKey) ? itemTimeKey.slice(0, 8) : requestedYmd;
      records.push({
        source: "ths",
        category,
        metric: "hot",
        snapshot_date: dateFromYmd(snapshotYmd),
        snapshot_key: itemTimeKey || `${requestedYmd}0000`,
        snapshot_time: thsSnapshotTimeFromKey(itemTimeKey),
        code,
        name: String(item.name || ""),
        market,
        rank: n(item.order),
        rank_change: n(item.hot_rank_chg),
        heat_value: n(item.rate),
        pct: null,
        price: null,
        float_market_value: null,
        main_tag: category === "stock" ? thsConceptTag(item) : "",
        raw: item,
      });
    }
  }
  return records;
}

async function fetchThsHotHistory(category, ymd) {
  const type = category === "stock" ? "stock" : category === "industry" ? "industry" : "concept";
  const url = `https://eq.10jqka.com.cn/open/api/hot_list/history/v1/rank?type=${type}&date=${ymd}`;
  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://eq.10jqka.com.cn/webpage/ths-hot-list/index.html",
    },
  });
  if (!response.ok) throw new Error(`同花顺热榜请求失败：${response.status}`);
  const json = await response.json();
  if (json.status_code !== 0) throw new Error(`同花顺热榜返回异常：${json.status_msg || json.status_code}`);
  return thsHistoryRecordsFromPayload(json, ymd, category);
}

function thsAttentionRecordFromRow(row, snapshotYmd, snapshotKey, snapshotTime) {
  const code = String(row?.[0] || "");
  const market = String(row?.[7] || "");
  if (!isAStockCode(code, market)) return null;
  return {
    source: "ths",
    category: "stock",
    metric: "attention",
    snapshot_date: dateFromYmd(snapshotYmd),
    snapshot_key: snapshotKey,
    snapshot_time: snapshotTime,
    code,
    name: String(row?.[1] || ""),
    market,
    rank: n(row?.[2]),
    rank_change: n(row?.[3]),
    heat_value: null,
    pct: n(row?.[4]),
    price: n(row?.[5]),
    float_market_value: n(row?.[6]),
    main_tag: "",
    raw: { rankRow: row },
  };
}

async function fetchThsAttentionDegree(code, snapshotYmd) {
  const url = `https://basic.10jqka.com.cn/api/stockph/popularity.php?code=${encodeURIComponent(code)}&data_type=rank`;
  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: `https://basic.10jqka.com.cn/stockph/attentionDegree.html?code=${encodeURIComponent(code)}`,
    },
  });
  if (!response.ok) throw new Error(`同花顺人气榜请求失败：${response.status}`);
  const json = await response.json();
  if (json.status_code !== 0) throw new Error(`同花顺人气榜返回异常：${json.status_msg || json.status_code}`);
  const data = json.data || {};
  const snapshotKey = `${snapshotYmd}1500`;
  const snapshotTime = `${dateFromYmd(snapshotYmd)}T15:00:00+08:00`;
  const rows = Array.isArray(data.rank_list) ? data.rank_list : [];
  return rows
    .map((row) => thsAttentionRecordFromRow(row, snapshotYmd, snapshotKey, snapshotTime))
    .filter(Boolean);
}

async function selectThsAttentionWatchlist(maxStocks, lookbackDays) {
  const { rows } = await getDbPool().query(
    `
      with bounds as (
        select coalesce(max(signal_date), current_date) as max_signal_date
        from strategy_signals
      )
      select s.code, max(s.signal_date) as latest_signal_date
      from strategy_signals s
      cross join bounds b
      where s.signal_date >= b.max_signal_date - ($1::int * interval '1 day')
      group by s.code
      order by max(s.signal_date) desc
      limit $2::int
    `,
    [lookbackDays, maxStocks],
  );
  return rows.map((row) => row.code).filter(Boolean);
}

async function upsertPopularitySnapshots(records) {
  const cleanRecords = records
    .filter((record) => record.source && record.category && record.metric && record.snapshot_date && record.snapshot_key && record.code)
    .map((record) => ({
      ...record,
      raw: record.raw || {},
    }));
  if (!cleanRecords.length) return 0;

  await getDbPool().query(
    `
      with input as (
        select *
        from jsonb_to_recordset($1::jsonb) as x(
          source text,
          category text,
          metric text,
          snapshot_date date,
          snapshot_key text,
          snapshot_time timestamptz,
          code text,
          name text,
          market text,
          rank integer,
          rank_change integer,
          heat_value numeric,
          pct numeric,
          price numeric,
          float_market_value numeric,
          main_tag text,
          raw jsonb
        )
      )
      insert into popularity_snapshots (
        source, category, metric, snapshot_date, snapshot_key, snapshot_time,
        code, name, market, rank, rank_change, heat_value, pct, price,
        float_market_value, main_tag, raw, updated_at
      )
      select
        source, category, metric, snapshot_date, snapshot_key, snapshot_time,
        code, name, market, rank, rank_change, heat_value, pct, price,
        float_market_value, main_tag, coalesce(raw, '{}'::jsonb), now()
      from input
      on conflict (source, category, metric, snapshot_key, code) do update set
        name = excluded.name,
        market = excluded.market,
        rank = excluded.rank,
        rank_change = excluded.rank_change,
        heat_value = excluded.heat_value,
        pct = excluded.pct,
        price = excluded.price,
        float_market_value = excluded.float_market_value,
        main_tag = excluded.main_tag,
        raw = excluded.raw,
        updated_at = now()
    `,
    [JSON.stringify(cleanRecords)],
  );

  const stockRecords = new Map();
  for (const record of cleanRecords) {
    if (record.category !== "stock" || !isAStockCode(record.code, record.market)) continue;
    stockRecords.set(record.code, {
      code: record.code,
      name: record.name || record.code,
      exchange: String(record.market) === "17" ? "SH" : "SZ",
      board: null,
      industry: null,
      region: null,
      concepts: record.main_tag ? [record.main_tag] : [],
      listing_date: null,
    });
  }
  await bulkUpsertStocksForSnapshots([...stockRecords.values()]);
  return cleanRecords.length;
}

async function bulkUpsertStocksForSnapshots(records) {
  if (!records.length) return;
  await getDbPool().query(
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
        concepts = case
          when jsonb_array_length(excluded.concepts) > 0 then excluded.concepts
          else stocks.concepts
        end,
        updated_at = now()
    `,
    [JSON.stringify(records)],
  );
}

async function runThsPopularitySync(options = {}) {
  requireDatabase();
  const requestedYmd = normalizeYmd(options.date);
  const lookbackDays = boundedInteger(
    options.lookbackDays ?? process.env.THS_WATCHLIST_LOOKBACK_DAYS ?? process.env.SYNC_LOOKBACK_DAYS,
    DEFAULT_SYNC_LOOKBACK_DAYS,
    1,
    365,
  );
  const watchlistMax = boundedInteger(
    options.watchlistMax ?? process.env.THS_WATCHLIST_MAX,
    DEFAULT_THS_WATCHLIST_MAX,
    0,
    200,
  );
  const includeAttention = options.includeAttention !== false && options.includeAttention !== "false";
  const categories = String(options.categories || process.env.THS_HOT_CATEGORIES || "stock,concept,industry")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => ["stock", "concept", "industry"].includes(item));
  const startedAt = new Date().toISOString();
  const params = { requestedYmd, categories, includeAttention, watchlistMax, lookbackDays };
  const run = await createSyncRun(THS_SYNC_JOB, { params, startedAt });
  const results = [];

  try {
    const allRecords = [];
    for (const category of categories) {
      const item = { category, metric: "hot", status: "pending" };
      try {
        const records = await fetchThsHotHistory(category, requestedYmd);
        item.status = "fetched";
        item.recordCount = records.length;
        item.actualDates = [...new Set(records.map((record) => record.snapshot_date))].sort();
        allRecords.push(...records);
      } catch (error) {
        item.status = "failed";
        item.error = error.message;
      }
      results.push(item);
    }

    const actualYmd =
      allRecords.find((record) => record.category === "stock")?.snapshot_key?.slice(0, 8) ||
      allRecords[0]?.snapshot_key?.slice(0, 8) ||
      requestedYmd;

    if (includeAttention) {
      const watchlist = await selectThsAttentionWatchlist(watchlistMax, lookbackDays);
      const attentionCodes = [...new Set(["300674", ...watchlist])];
      const item = { category: "stock", metric: "attention", status: "pending", requestedCodes: attentionCodes.length };
      const attentionRecords = [];
      const failures = [];
      for (const code of attentionCodes) {
        try {
          attentionRecords.push(...(await fetchThsAttentionDegree(code, actualYmd)));
        } catch (error) {
          failures.push({ code, error: error.message });
        }
      }
      item.status = failures.length && !attentionRecords.length ? "failed" : failures.length ? "partial" : "fetched";
      item.recordCount = attentionRecords.length;
      item.uniqueCount = new Set(attentionRecords.map((record) => record.code)).size;
      item.failures = failures.slice(0, 10);
      allRecords.push(...attentionRecords);
      results.push(item);
    }

    const uniqueRecords = new Map();
    for (const record of allRecords) {
      uniqueRecords.set(`${record.source}:${record.category}:${record.metric}:${record.snapshot_key}:${record.code}`, record);
    }
    const savedCount = await upsertPopularitySnapshots([...uniqueRecords.values()]);
    const failedCount = results.filter((item) => item.status === "failed").length;
    const partialCount = results.filter((item) => item.status === "partial").length;
    const summary = {
      jobName: THS_SYNC_JOB,
      runId: run.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      params: { ...params, actualYmd },
      selectedCount: uniqueRecords.size,
      successCount: savedCount,
      failedCount,
      partialCount,
      results,
    };
    const status = failedCount ? (savedCount ? "partial" : "failed") : partialCount ? "partial" : "success";
    await finishSyncRun(run.id, status, summary, failedCount && !savedCount ? "all ths categories failed" : null);
    cachedDbData.clear();
    cachedThsData.clear();
    return { ...summary, status };
  } catch (error) {
    const summary = {
      jobName: THS_SYNC_JOB,
      runId: run.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      params,
      selectedCount: 0,
      successCount: 0,
      failedCount: 1,
      results,
    };
    await finishSyncRun(run.id, "failed", summary, error.message);
    throw error;
  }
}

async function thsSyncPayload(query = {}, headers = {}) {
  assertCronAuthorized(query, headers);
  return runThsPopularitySync({
    date: query.date,
    categories: query.categories,
    includeAttention: query.includeAttention,
    watchlistMax: query.watchlistMax,
    lookbackDays: query.lookbackDays,
  });
}

function findTradingIndex(rows, date, useNext = false) {
  const exact = rows.findIndex((row) => row.date === date);
  if (exact >= 0) return useNext ? exact + 1 : exact;
  return rows.findIndex((row) => row.date > date);
}

function dailyReturnAt(rows, index) {
  const row = rows[index];
  if (!row) return null;
  if (Number.isFinite(row.pct)) return row.pct / 100;
  const prev = rows[index - 1];
  if (prev && Number.isFinite(prev.close) && prev.close !== 0 && Number.isFinite(row.close)) {
    return (row.close - prev.close) / prev.close;
  }
  return null;
}

function returnAt(rows, entryIndex, entryPrice, horizon) {
  const days = typeof horizon === "number" ? horizon : horizon.days;
  const exitIndex = entryIndex + days;
  if (exitIndex >= rows.length) {
    return {
      days,
      label: typeof horizon === "number" ? `${days}日` : horizon.label,
      exitDate: null,
      exitClose: null,
      return: null,
      dayReturn: null,
      maxReturn: null,
      maxDrawdown: null,
      status: "未到期",
    };
  }
  const holdingRows = rows.slice(entryIndex, exitIndex + 1);
  const highValues = holdingRows
    .map((row) => (Number.isFinite(row.high) ? row.high : Math.max(row.open, row.close)))
    .filter(Number.isFinite);
  const lowValues = holdingRows
    .map((row) => (Number.isFinite(row.low) ? row.low : Math.min(row.open, row.close)))
    .filter(Number.isFinite);
  const maxHigh = Math.max(...highValues);
  const minLow = Math.min(...lowValues);
  const exit = rows[exitIndex];
  return {
    days,
    label: typeof horizon === "number" ? `${days}日` : horizon.label,
    exitDate: exit.date,
    exitClose: exit.close,
    return: (exit.close - entryPrice) / entryPrice,
    dayReturn: dailyReturnAt(rows, exitIndex),
    maxReturn: Number.isFinite(maxHigh) ? (maxHigh - entryPrice) / entryPrice : null,
    maxDrawdown: Number.isFinite(minLow) ? (minLow - entryPrice) / entryPrice : null,
    status: "已到期",
  };
}

function returnAtCurrent(rows, entryIndex, entryPrice) {
  const exitIndex = rows.length - 1;
  if (entryIndex < 0 || exitIndex < entryIndex || !Number.isFinite(entryPrice)) {
    return {
      label: "当前",
      exitDate: null,
      exitClose: null,
      return: null,
      dayReturn: null,
      maxReturn: null,
      maxDrawdown: null,
      status: "暂无当前数据",
      current: true,
    };
  }
  const holdingRows = rows.slice(entryIndex, exitIndex + 1);
  const highValues = holdingRows
    .map((row) => (Number.isFinite(row.high) ? row.high : Math.max(row.open, row.close)))
    .filter(Number.isFinite);
  const lowValues = holdingRows
    .map((row) => (Number.isFinite(row.low) ? row.low : Math.min(row.open, row.close)))
    .filter(Number.isFinite);
  const maxHigh = Math.max(...highValues);
  const minLow = Math.min(...lowValues);
  const exit = rows[exitIndex];
  return {
    label: "当前",
    exitDate: exit.date,
    exitClose: exit.close,
    return: (exit.close - entryPrice) / entryPrice,
    dayReturn: dailyReturnAt(rows, exitIndex),
    maxReturn: Number.isFinite(maxHigh) ? (maxHigh - entryPrice) / entryPrice : null,
    maxDrawdown: Number.isFinite(minLow) ? (minLow - entryPrice) / entryPrice : null,
    status: "最新收盘",
    current: true,
  };
}

function benchmarkReturnForHorizon(rows, entryDate, entryMode, horizon) {
  const entryIndex = rows.findIndex((row) => row.date === entryDate);
  if (entryIndex < 0) return null;
  const entryRow = rows[entryIndex];
  const entryPrice = entryMode === "close" ? entryRow.close : entryRow.open;
  if (!Number.isFinite(entryPrice)) return null;
  return horizon.current ? returnAtCurrent(rows, entryIndex, entryPrice) : returnAt(rows, entryIndex, entryPrice, horizon);
}

function attachBenchmarkToPositionHorizons(horizons, benchmarkRows, entryDate, entryMode, benchmark = MARKET_INDEX) {
  if (!Array.isArray(benchmarkRows) || !benchmarkRows.length) return horizons;
  return horizons.map((horizon) => {
    const benchmarkResult = benchmarkReturnForHorizon(benchmarkRows, entryDate, entryMode, horizon);
    const benchmarkReturn = benchmarkResult?.return ?? null;
    return {
      ...horizon,
      benchmark: benchmarkResult
        ? {
            key: benchmark.key,
            name: benchmark.name,
            exitDate: benchmarkResult.exitDate,
            exitClose: benchmarkResult.exitClose,
            return: benchmarkReturn,
            dayReturn: benchmarkResult.dayReturn,
            status: benchmarkResult.status,
          }
        : null,
      excessReturn: Number.isFinite(horizon.return) && Number.isFinite(benchmarkReturn) ? horizon.return - benchmarkReturn : null,
    };
  });
}

async function positionPayload(query) {
  const stock = normalizeStock(query.code);
  if (!query.date) throw new Error("请输入买入日期");
  const entryMode = query.entry || "nextOpen";
  const rows = await loadKline(stock);
  const benchmarkRows = await loadMarketIndexKline().catch(() => []);
  const names = readStockNames();
  const storedMeta = readStockMeta().get(stock.code);
  const displayName = await resolveStockDisplayName(stock.code, storedMeta?.name || names.get(stock.code));
  const useNextTradingDay = entryMode === "nextOpen";
  const entryIndex = findTradingIndex(rows, query.date, useNextTradingDay);
  if (entryIndex < 0 || entryIndex >= rows.length) throw new Error(`找不到 ${query.date} 之后的交易日`);
  const entryRow = rows[entryIndex];
  const entryPrice = entryMode === "close" ? entryRow.close : entryRow.open;
  const meta = enrichStockMeta(stock.code, displayName || stock.code, query.date);
  const horizonDefs = [
    { days: 1, label: "1天" },
    { days: 2, label: "2天" },
    { days: 3, label: "3天" },
    { days: 4, label: "4天" },
    { days: 5, label: "5天" },
    { days: 5, label: "1周" },
    { days: 10, label: "2周" },
  ];
  const horizons = attachBenchmarkToPositionHorizons(
    [returnAtCurrent(rows, entryIndex, entryPrice), ...horizonDefs.map((horizon) => returnAt(rows, entryIndex, entryPrice, horizon))],
    benchmarkRows,
    entryRow.date,
    entryMode,
  );
  return {
    code: stock.code,
    em: stock.em,
    name: meta.name || displayName || stock.code,
    meta,
    requestedDate: query.date,
    entryMode,
    entryModeLabel: entryMode === "close" ? "当日收盘" : entryMode === "open" ? "当日开盘" : "信号次日开盘",
    entryDate: entryRow.date,
    entryPrice,
    entryOpen: entryRow.open,
    entryClose: entryRow.close,
    benchmark: MARKET_INDEX,
    horizons,
    latestDate: rows[rows.length - 1]?.date || null,
  };
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function sendFile(res, requestPath) {
  const normalized = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, normalized));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(filePath).pipe(res);
}

function normalizeRequestBody(body) {
  if (!body) return {};
  if (typeof body === "object" && !Buffer.isBuffer(body)) return body;
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    const wrapped = new Error("请求体不是合法 JSON");
    wrapped.statusCode = 400;
    throw wrapped;
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function handleApiRequest(pathname, query, headers = {}, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const body = normalizeRequestBody(options.body);
  if (pathname === "/api/overview") return overviewPayload(query);
  if (pathname === "/api/daily") return dailyPayload(query);
  if (pathname === "/api/timeline") return timelinePayload(query);
  if (pathname === "/api/evaluation") return evaluationPayload(query);
  if (pathname === "/api/strategy-configs" && method === "GET") return strategyConfigsPayload(query);
  if (pathname === "/api/strategy-configs" && method === "POST") return saveStrategyConfigPayload({ ...body, source: body.source || query.source });
  if (pathname === "/api/stock-signals") return stockSignalsPayload(query);
  if (pathname === "/api/position") return positionPayload(query);
  if (pathname === "/api/cron/daily-sync") return dailySyncPayload(query, headers);
  if (pathname === "/api/cron/ths-sync") return thsSyncPayload(query, headers);
  const error = new Error("Not found");
  error.statusCode = 404;
  throw error;
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${HOST}:${PORT}`);
  const query = Object.fromEntries(parsed.searchParams.entries());
  try {
    if (parsed.pathname.startsWith("/api/")) {
      const body = ["POST", "PUT", "PATCH"].includes(req.method || "") ? await readRequestBody(req) : "";
      sendJson(res, await handleApiRequest(parsed.pathname, query, req.headers, { method: req.method, body }));
    } else {
      sendFile(res, parsed.pathname);
    }
  } catch (error) {
    sendJson(res, { error: error.message }, error.statusCode || 500);
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Strategy dashboard running at http://${HOST}:${PORT}`);
  });
}

module.exports = {
  handleApiRequest,
  overviewPayload,
  dailyPayload,
  timelinePayload,
  stockSignalsPayload,
  positionPayload,
  strategyConfigsPayload,
  evaluationPayload,
  dailySyncPayload,
  runDailyKlineSync,
  thsSyncPayload,
  runThsPopularitySync,
  upsertPopularitySnapshots,
};
