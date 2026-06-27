#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const path = require("path");
const { Pool } = require("pg");

const ROOT = path.resolve(__dirname, "../..");
loadEnvFile(path.join(ROOT, ".env"));
const PUBLIC_DIR = path.join(__dirname, "public");
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
let cachedThsData;
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

function normalizeStrategyKey(raw) {
  return STRATEGIES[raw] ? raw : "early";
}

function loadThsData() {
  if (cachedThsData) return cachedThsData;
  if (!fs.existsSync(THS_CANDIDATES_FILE)) {
    cachedThsData = emptyData(
      "ths",
      THS_CANDIDATES_FILE,
      "同花顺历史人气数据尚未积累。开始每日采集后，把统一格式文件写入 outputs/ths-popularity-strategy-candidates.csv 即可在这里回测。",
    );
    return cachedThsData;
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
      event.riskFlags = riskFlags(event);
      return event;
    })
    .filter(Boolean);

  cachedThsData = finalizeData(events, THS_CANDIDATES_FILE, "ths", {
    strategy: STRATEGIES.early,
    available: events.length > 0,
    message: events.length ? "" : "同花顺统一数据文件存在，但没有可用候选记录。",
  });
  return cachedThsData;
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
    hasStrongIndustry: bestBoardType === "industry" || raw.hasStrongIndustry === "true",
    hasStrongConcept: bestBoardType === "concept" || raw.hasStrongConcept === "true",
    meta,
  };
  event.strictBoard = !PSEUDO_BOARD_RE.test(event.bestBoardName || "");
  event.score = n(row.score) ?? (strategyKey === "hot" ? scoreHotEvent(event) : scoreEvent(event));
  event.modelScore = n(row.model_score) ?? n(raw.finalScore);
  event.sortScore = event.modelScore ?? event.score;
  event.riskFlags = strategyKey === "hot" ? hotRiskFlags(event) : riskFlags(event);
  return event;
}

async function loadDataForSource(rawSource, rawStrategy) {
  const sourceKey = normalizeSourceKey(rawSource);
  const strategyKey = normalizeStrategyKey(rawStrategy);
  if (sourceKey === "ths") return loadThsData();
  if (shouldUseDatabase(sourceKey)) return loadDbData(sourceKey, strategyKey);
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
  const tradingDates = readTradingCalendar().filter(
    (date) => date >= (signalDates[0] || date) && date <= (signalDates[signalDates.length - 1] || date),
  );
  const requestedDate = query.date || signalDates[signalDates.length - 1] || null;
  const isTradingDate = !requestedDate || !tradingDates.length || tradingDates.includes(requestedDate);
  const selectedDate = !requestedDate
    ? signalDates[signalDates.length - 1] || null
    : isTradingDate
      ? requestedDate
      : previousDate(tradingDates, requestedDate) || nextAvailableDate(tradingDates, requestedDate) || requestedDate;
  const exactDate = !query.date || query.date === selectedDate;
  const events = selectedDate ? [...(map.get(selectedDate) || [])].sort((a, b) => b.sortScore - a.sortScore) : [];
  return {
    selectedDate,
    requestedDate: query.date || null,
    exactDate,
    nextAvailableDate: exactDate ? null : nextAvailableDate(signalDates, query.date),
    strict,
    availableDates: signalDates,
    tradingDates,
    dateStatus: dateStatus(query.date || null, selectedDate, tradingDates, signalDates),
    source: data.dataSource.description,
    dataSource: data.dataSource,
    dataStrategy: data.dataSource.strategy,
    rule: data.dataSource.strategy?.rule || STRATEGIES.early.rule,
    stats: summarize(events),
    signalStats: summarizeSignals(events),
    boards: aggregateBoards(events),
    stocks: events,
  };
}

async function timelinePayload(query) {
  const data = await loadDataForSource(query.source, query.strategy);
  const strict = query.strict !== "false";
  const dates = strict ? data.dates : data.allDates;
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
  const tradingDates = readTradingCalendar().filter(
    (date) => date >= (data.dates[0] || date) && date <= (data.dates[data.dates.length - 1] || date),
  );
  return {
    generatedAt: data.generatedAt,
    sourceFile: data.sourceFile,
    sourceKey: data.sourceKey,
    dataSource: data.dataSource,
    availableSources: Object.values(DATA_SOURCES),
    availableStrategies: Object.values(STRATEGIES),
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
    matches: matches.map((event) => ({
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
      ret5: event.ret5,
      ret10: event.ret10,
      ret20: event.ret20,
      score: event.score,
      modelScore: event.modelScore,
      riskFlags: event.riskFlags || [],
      meta: event.meta,
      signalInsight: event.signalInsight,
    })),
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

async function fetchKline(stock) {
  const url =
    "https://push2his.eastmoney.com/api/qt/stock/kline/get" +
    `?secid=${stock.secid}` +
    "&fields1=f1,f2,f3,f4,f5,f6" +
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61" +
    "&klt=101&fqt=1&beg=20200101&end=20500101&lmt=1000000";
  const response = await fetch(url, {
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

function findTradingIndex(rows, date, useNext = false) {
  const exact = rows.findIndex((row) => row.date === date);
  if (exact >= 0) return useNext ? exact + 1 : exact;
  return rows.findIndex((row) => row.date > date);
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
    maxReturn: Number.isFinite(maxHigh) ? (maxHigh - entryPrice) / entryPrice : null,
    maxDrawdown: Number.isFinite(minLow) ? (minLow - entryPrice) / entryPrice : null,
    status: "最新收盘",
    current: true,
  };
}

async function positionPayload(query) {
  const stock = normalizeStock(query.code);
  if (!query.date) throw new Error("请输入买入日期");
  const entryMode = query.entry || "nextOpen";
  const rows = await loadKline(stock);
  const names = readStockNames();
  const storedMeta = readStockMeta().get(stock.code);
  const useNextTradingDay = entryMode === "nextOpen";
  const entryIndex = findTradingIndex(rows, query.date, useNextTradingDay);
  if (entryIndex < 0 || entryIndex >= rows.length) throw new Error(`找不到 ${query.date} 之后的交易日`);
  const entryRow = rows[entryIndex];
  const entryPrice = entryMode === "close" ? entryRow.close : entryRow.open;
  const meta = enrichStockMeta(stock.code, storedMeta?.name || names.get(stock.code) || stock.code, query.date);
  const horizonDefs = [
    { days: 1, label: "1天" },
    { days: 2, label: "2天" },
    { days: 3, label: "3天" },
    { days: 4, label: "4天" },
    { days: 5, label: "5天" },
    { days: 5, label: "1周" },
    { days: 10, label: "2周" },
  ];
  const horizons = [returnAtCurrent(rows, entryIndex, entryPrice), ...horizonDefs.map((horizon) => returnAt(rows, entryIndex, entryPrice, horizon))];
  return {
    code: stock.code,
    em: stock.em,
    name: meta.name || names.get(stock.code) || stock.code,
    meta,
    requestedDate: query.date,
    entryMode,
    entryModeLabel: entryMode === "close" ? "当日收盘" : entryMode === "open" ? "当日开盘" : "信号次日开盘",
    entryDate: entryRow.date,
    entryPrice,
    entryOpen: entryRow.open,
    entryClose: entryRow.close,
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

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${HOST}:${PORT}`);
  const query = Object.fromEntries(parsed.searchParams.entries());
  try {
    if (parsed.pathname === "/api/overview") {
      sendJson(res, await overviewPayload(query));
    } else if (parsed.pathname === "/api/daily") {
      sendJson(res, await dailyPayload(query));
    } else if (parsed.pathname === "/api/timeline") {
      sendJson(res, await timelinePayload(query));
    } else if (parsed.pathname === "/api/stock-signals") {
      sendJson(res, await stockSignalsPayload(query));
    } else if (parsed.pathname === "/api/position") {
      positionPayload(query).then((payload) => sendJson(res, payload)).catch((error) => sendJson(res, { error: error.message }, 500));
    } else {
      sendFile(res, parsed.pathname);
    }
  } catch (error) {
    sendJson(res, { error: error.message }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Strategy dashboard running at http://${HOST}:${PORT}`);
});
