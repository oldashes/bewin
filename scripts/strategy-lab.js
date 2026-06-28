#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const FEATURE_FILE = path.join(ROOT, "outputs/em-popularity-sector-filter-all-enriched.csv");
const KLINE_DIR = path.join(ROOT, "work/cache/eastmoney-popularity-backtest/kline");
const BOARD_MEMBER_DIR = path.join(ROOT, "work/cache/sector-filter-backtest/board-members");
const PSEUDO_BOARD_RE =
  /(百日|新高|新低|昨日|近期|最近|连板|涨停|打板|首板|触板|一字|破板|竞价|低价|高价|融资|沪股通|深股通|破净|红利|ST|季报|年报|预增|预盈|预亏|业绩|基金|重仓|成份|送转|转债|MSCI|富时|标普|证金|养老金)/;

const DEFAULT_OPTIONS = {
  from: "2025-09-29",
  to: "2026-06-03",
  trainTo: "2026-03-31",
  testFrom: "2026-04-01",
  horizon: "ret20",
  objective: "balanced",
  minSamples: 40,
  minDates: 12,
  minTestSamples: 20,
  minTestDates: 8,
  top: 12,
  strict: true,
};

const HORIZONS = [
  { key: "ret5", label: "5d", days: 5 },
  { key: "ret10", label: "10d", days: 10 },
  { key: "ret20", label: "20d", days: 20 },
];

main();

function main() {
  const options = parseArgs(process.argv.slice(2));
  const universe = loadKlineUniverse(KLINE_DIR);
  const klineByCode = new Map(universe.map((item) => [item.code, item.rows]));
  const boardMembers = loadBoardMembers(BOARD_MEMBER_DIR);
  const boardContext = createBoardContext(boardMembers, klineByCode);
  const rows = loadFeatureRows(FEATURE_FILE)
    .map(enrichRow)
    .map((row) => attachBoardContext(row, boardContext))
    .map((row) => ({ ...row, attribution: attributionType(row) }))
    .filter((row) => row.signalDate >= options.from && row.signalDate <= options.to)
    .filter((row) => !options.strict || row.strictBoard);
  const market = createMarketBaseline(universe);

  console.log(`feature rows: ${rows.length}`);
  console.log(`kline universe: ${universe.length}`);
  console.log(`board member groups: ${boardMembers.size}`);
  console.log(`range: ${options.from}..${options.to}, strict=${options.strict}`);
  console.log("");

  printAttributionSummary(rows, market);
  console.log("");

  const trainRows = rows.filter((row) => row.signalDate <= options.trainTo);
  const testRows = rows.filter((row) => row.signalDate >= options.testFrom);
  const configs = buildGridConfigs();
  const ranked = configs
    .map((config) => {
      const train = evaluateConfig(trainRows, config, market, options.horizon);
      if (train.matured < options.minSamples || train.dateCount < options.minDates) return null;
      const test = evaluateConfig(testRows, config, market, options.horizon);
      if (test.matured < options.minTestSamples || test.dateCount < options.minTestDates) return null;
      const full = evaluateConfig(rows, config, market, options.horizon);
      return { config, train, test, full };
    })
    .filter(Boolean)
    .sort((a, b) => scoreSearchResult(b, options.objective) - scoreSearchResult(a, options.objective))
    .slice(0, options.top);

  printSearchResults(ranked, options.horizon);
}

function parseArgs(args) {
  const options = { ...DEFAULT_OPTIONS };
  for (const arg of args) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (key === "strict") options.strict = raw !== "false";
    else if (key === "min-samples") options.minSamples = Number(raw);
    else if (key === "min-dates") options.minDates = Number(raw);
    else if (key === "min-test-samples") options.minTestSamples = Number(raw);
    else if (key === "min-test-dates") options.minTestDates = Number(raw);
    else if (key === "top") options.top = Number(raw);
    else if (key === "horizon") options.horizon = raw;
    else if (key === "objective") options.objective = raw;
    else if (key === "from") options.from = raw;
    else if (key === "to") options.to = raw;
    else if (key === "train-to") options.trainTo = raw;
    else if (key === "test-from") options.testFrom = raw;
  }
  if (!HORIZONS.some((horizon) => horizon.key === options.horizon)) {
    throw new Error(`Unsupported horizon: ${options.horizon}`);
  }
  return options;
}

function loadFeatureRows(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing feature file: ${file}`);
  return parseCsv(fs.readFileSync(file, "utf8"));
}

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
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
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

function enrichRow(row) {
  const rank = int(row.rank);
  const rank20 = int(row.rank20);
  const prev5 = num(row.prev5);
  const boardRet5 = num(row.bestBoardRet5);
  const amountRatio = num(row.amountRatio);
  const boardAmountRatio = num(row.bestBoardAmountRatio);
  const rankDelta20 = rank && rank20 ? rank20 - rank : num(row.rankDelta20);
  const relativeRet5 = Number.isFinite(prev5) && Number.isFinite(boardRet5) ? prev5 - boardRet5 : null;
  const strictBoard = !PSEUDO_BOARD_RE.test(row.bestBoardName || "");
  const enriched = {
    ...row,
    code: String(row.code || "").match(/\d{6}/)?.[0] || "",
    signalDate: row.signalDate,
    rank,
    rank20,
    rankDelta20,
    prev5,
    prev10: num(row.prev10),
    amountRatio,
    turnover5: num(row.turnover5),
    ret5: num(row.ret5),
    ret10: num(row.ret10),
    ret20: num(row.ret20),
    boardCount: int(row.boardCount),
    bestBoardType: row.bestBoardType || "",
    bestBoardName: row.bestBoardName || "",
    bestBoardRet5: boardRet5,
    bestBoardRet10: num(row.bestBoardRet10),
    bestBoardAmountRatio: boardAmountRatio,
    bestBoardScoreRankPct: num(row.bestBoardScoreRankPct),
    relativeRet5,
    strictBoard,
  };
  return enriched;
}

function attributionType(row) {
  const breadthOk = !Number.isFinite(row.boardPositiveRatio) || row.boardPositiveRatio >= 0.42;
  const leaderOk = !Number.isFinite(row.boardLeaderPct) || row.boardLeaderPct <= 0.35;
  const boardStrong = row.bestBoardRet5 >= 0.04 && row.bestBoardAmountRatio >= 1.2 && breadthOk;
  const boardVeryStrong = row.bestBoardRet5 >= 0.08 && row.bestBoardAmountRatio >= 1.4 && breadthOk;
  const stockStrong = row.prev5 >= 0.03 && row.amountRatio >= 1.1;
  const stockVeryStrong = row.prev5 >= 0.08 && row.amountRatio >= 1.2;
  const outperformsBoard = row.relativeRet5 >= 0.03 || (leaderOk && row.relativeRet5 >= 0);
  const lagsBoard = row.relativeRet5 <= -0.03;
  const overheated = row.prev5 >= 0.18 || row.amountRatio >= 2.8 || row.bestBoardRet5 >= 0.16;

  if (overheated && boardStrong && stockStrong) return "overheated_resonance";
  if (overheated) return "overheated_stock";
  if (boardStrong && stockStrong && outperformsBoard) return "resonance_leader";
  if (boardStrong && stockStrong) return "resonance_follow";
  if (boardVeryStrong && lagsBoard) return "board_led_lag";
  if (boardStrong && row.prev5 <= 0.02 && row.rankDelta20 >= 500) return "board_pullback";
  if (stockVeryStrong && !boardStrong && outperformsBoard) return "stock_led";
  if (stockStrong && row.bestBoardRet5 < 0.02) return "isolated_stock";
  if (boardStrong) return "board_led";
  return "weak_or_early";
}

function loadKlineUniverse(dir) {
  if (!fs.existsSync(dir)) return [];
  const universe = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const code = path.basename(file, ".json").split(".")[1] || "";
    if (!/^(00|30|60|68)/.test(code)) continue;
    let rows;
    try {
      rows = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(rows) || rows.length < 80) continue;
    universe.push({ code, rows });
  }
  return universe;
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
        boardMemberAvgRet5: avg(values),
        boardMemberMedianRet5: median(values),
        memberReturns: returns,
      };
      cache.set(key, stats);
      return stats;
    },
  };
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

function attachBoardContext(row, boardContext) {
  const stats = boardContext.stats(row.bestBoardCode, row.signalDate);
  const memberReturns = stats.memberReturns || [];
  const candidateRet = Number.isFinite(row.prev5) ? row.prev5 : null;
  let boardLeaderPct = null;
  let boardLeaderRank = null;
  if (Number.isFinite(candidateRet) && memberReturns.length) {
    const sorted = memberReturns.map((item) => item.ret5).sort((a, b) => b - a);
    const betterCount = sorted.filter((value) => value > candidateRet).length;
    boardLeaderRank = betterCount + 1;
    boardLeaderPct = boardLeaderRank / sorted.length;
  }
  const { memberReturns: _memberReturns, ...publicStats } = stats;
  return {
    ...row,
    ...publicStats,
    boardLeaderRank,
    boardLeaderPct,
    boardMemberExcessRet5:
      Number.isFinite(row.prev5) && Number.isFinite(stats.boardMemberMedianRet5)
        ? row.prev5 - stats.boardMemberMedianRet5
        : null,
  };
}

function stockPrevReturn(rows, signalDate, days) {
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

function createMarketBaseline(universe) {
  const cache = new Map();
  return {
    dailyStats(date, horizonKey) {
      const horizon = HORIZONS.find((item) => item.key === horizonKey);
      const key = `${date}:${horizonKey}`;
      if (cache.has(key)) return cache.get(key);
      const returns = universe
        .map((item) => returnAt(item.rows, date, horizon.days))
        .filter(Number.isFinite);
      const stats = summarizeReturns(returns);
      cache.set(key, stats);
      return stats;
    },
  };
}

function findTradingIndex(rows, date, useNext = false) {
  const exact = rows.findIndex((row) => row.date === date);
  if (exact >= 0) return useNext ? exact + 1 : exact;
  return rows.findIndex((row) => row.date > date);
}

function returnAt(rows, signalDate, days) {
  const entryIndex = findTradingIndex(rows, signalDate, true);
  if (entryIndex < 0 || entryIndex + days >= rows.length) return null;
  const entry = rows[entryIndex];
  const exit = rows[entryIndex + days];
  if (!entry || !exit || !Number.isFinite(entry.open) || entry.open <= 0 || !Number.isFinite(exit.close)) return null;
  return (exit.close - entry.open) / entry.open;
}

function printAttributionSummary(rows, market) {
  console.log("attribution summary, full range:");
  const rowsByType = groupBy(rows, (row) => row.attribution);
  const table = [...rowsByType.entries()]
    .map(([type, items]) => {
      const ret20 = evaluateEvents(items, market, "ret20");
      return {
        type,
        samples: items.length,
        dates: new Set(items.map((row) => row.signalDate)).size,
        win20: percent(ret20.winRate),
        avg20: percent(ret20.avg),
        randomWin20: percent(ret20.randomWinRate),
        randomAvg20: percent(ret20.randomAvg),
        excessWin20: pp(ret20.winExcess),
        excessAvg20: pp(ret20.avgExcess),
      };
    })
    .sort((a, b) => b.samples - a.samples);
  console.table(table);
}

function buildGridConfigs() {
  const rankRanges = [
    [1, 100],
    [100, 400],
    [200, 700],
    [350, 900],
    [400, 1200],
    [600, 1600],
  ];
  const rankDeltaMins = [0, 300, 500, 800, 1200, 1600];
  const amountRanges = [
    [0.8, 3.5],
    [1, 2.5],
    [1.1, 2.2],
    [1.2, 2],
    [1.5, 3],
  ];
  const stockPrev5Ranges = [
    [-0.2, 0.35],
    [-0.08, 0.22],
    [-0.05, 0.15],
    [0, 0.2],
    [0.03, 0.18],
    [0.05, 0.25],
    [-0.15, 0.1],
  ];
  const boardRetRanges = [
    [-1, 3],
    [-0.05, 0.08],
    [0, 0.2],
    [0.03, 0.15],
    [0.04, 0.12],
    [0.05, 0.18],
    [0.08, 0.2],
  ];
  const boardAmountRanges = [
    [0, 20],
    [1, 2.5],
    [1.2, 2],
    [1.2, 1.8],
    [1.5, 2.5],
  ];
  const attributionSets = [
    [],
    ["resonance_leader"],
    ["resonance_leader", "resonance_follow"],
    ["resonance_leader", "board_pullback"],
    ["board_pullback"],
    ["stock_led"],
    ["resonance_leader", "stock_led"],
    ["board_led", "board_pullback"],
  ];
  const maxPerDateValues = [0, 3, 5];
  const configs = [];
  for (const [rankMin, rankMax] of rankRanges) {
    for (const rankDeltaMin of rankDeltaMins) {
      for (const [amountMin, amountMax] of amountRanges) {
        for (const [stockPrev5Min, stockPrev5Max] of stockPrev5Ranges) {
          for (const [boardRet5Min, boardRet5Max] of boardRetRanges) {
            for (const [boardAmountMin, boardAmountMax] of boardAmountRanges) {
              for (const attributions of attributionSets) {
                for (const maxPerDate of maxPerDateValues) {
                  configs.push({
                    rankMin,
                    rankMax,
                    rankDeltaMin,
                    amountMin,
                    amountMax,
                    stockPrev5Min,
                    stockPrev5Max,
                    boardRet5Min,
                    boardRet5Max,
                    boardAmountMin,
                    boardAmountMax,
                    attributions,
                    maxPerDate,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return [...configs, ...buildFocusedBoardConfigs()];
}

function buildFocusedBoardConfigs() {
  const rankRanges = [
    [200, 700],
    [400, 1200],
    [600, 1600],
  ];
  const rankDeltaMins = [0, 300, 500, 800];
  const amountRanges = [
    [1.2, 2.5],
    [1.5, 3],
  ];
  const stockPrev5Ranges = [
    [-0.08, 0.22],
    [0, 0.2],
    [0.03, 0.18],
    [0.05, 0.25],
  ];
  const boardRetRanges = [
    [0, 0.2],
    [0.03, 0.15],
    [0.05, 0.18],
  ];
  const boardAmountRanges = [
    [1, 2.5],
    [1.2, 2],
    [1.2, 1.8],
  ];
  const attributionSets = [
    [],
    ["resonance_leader", "resonance_follow"],
    ["resonance_leader", "stock_led"],
  ];
  const maxPerDateValues = [0, 3, 5];
  const boardProfiles = [
    { name: "leader35", maxLeaderPct: 0.35 },
    { name: "leader25", maxLeaderPct: 0.25 },
    { name: "breadth50", minPositiveRatio: 0.5 },
    { name: "breadth60", minPositiveRatio: 0.6 },
    { name: "leader35+breadth50", maxLeaderPct: 0.35, minPositiveRatio: 0.5 },
    { name: "leader25+breadth50", maxLeaderPct: 0.25, minPositiveRatio: 0.5 },
    { name: "leader35+hot25", maxLeaderPct: 0.35, minHotRatio: 0.25 },
    { name: "leader25+hot25", maxLeaderPct: 0.25, minHotRatio: 0.25 },
  ];
  const configs = [];
  for (const [rankMin, rankMax] of rankRanges) {
    for (const rankDeltaMin of rankDeltaMins) {
      for (const [amountMin, amountMax] of amountRanges) {
        for (const [stockPrev5Min, stockPrev5Max] of stockPrev5Ranges) {
          for (const [boardRet5Min, boardRet5Max] of boardRetRanges) {
            for (const [boardAmountMin, boardAmountMax] of boardAmountRanges) {
              for (const attributions of attributionSets) {
                for (const maxPerDate of maxPerDateValues) {
                  for (const boardProfile of boardProfiles) {
                    configs.push({
                      rankMin,
                      rankMax,
                      rankDeltaMin,
                      amountMin,
                      amountMax,
                      stockPrev5Min,
                      stockPrev5Max,
                      boardRet5Min,
                      boardRet5Max,
                      boardAmountMin,
                      boardAmountMax,
                      attributions,
                      maxPerDate,
                      boardProfile,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return configs;
}

function evaluateConfig(rows, config, market, horizonKey) {
  const filtered = rows.filter((row) => matchesConfig(row, config));
  const capped = capPerDate(filtered, config.maxPerDate);
  const stats = evaluateEvents(capped, market, horizonKey);
  return { ...stats, count: capped.length, dateCount: new Set(capped.map((row) => row.signalDate)).size };
}

function matchesConfig(row, config) {
  if (!between(row.rank, config.rankMin, config.rankMax)) return false;
  if (!Number.isFinite(row.rankDelta20) || row.rankDelta20 < config.rankDeltaMin) return false;
  if (!between(row.amountRatio, config.amountMin, config.amountMax)) return false;
  if (!between(row.prev5, config.stockPrev5Min, config.stockPrev5Max)) return false;
  if (!between(row.bestBoardRet5, config.boardRet5Min, config.boardRet5Max)) return false;
  if (!between(row.bestBoardAmountRatio, config.boardAmountMin, config.boardAmountMax)) return false;
  if (config.attributions.length && !config.attributions.includes(row.attribution)) return false;
  if (config.boardProfile && !matchesBoardProfile(row, config.boardProfile)) return false;
  return true;
}

function matchesBoardProfile(row, profile) {
  if (Number.isFinite(profile.maxLeaderPct) && !between(row.boardLeaderPct, 0, profile.maxLeaderPct)) return false;
  if (Number.isFinite(profile.minPositiveRatio) && (!Number.isFinite(row.boardPositiveRatio) || row.boardPositiveRatio < profile.minPositiveRatio)) {
    return false;
  }
  if (Number.isFinite(profile.minHotRatio) && (!Number.isFinite(row.boardHotRatio) || row.boardHotRatio < profile.minHotRatio)) {
    return false;
  }
  if (row.boardValidMemberCount !== null && row.boardValidMemberCount < 8) return false;
  return true;
}

function capPerDate(rows, maxPerDate) {
  if (!maxPerDate) return rows;
  return [...groupBy(rows, (row) => row.signalDate).values()].flatMap((items) =>
    items
      .slice()
      .sort((a, b) => configSortScore(b) - configSortScore(a) || a.rank - b.rank)
      .slice(0, maxPerDate),
  );
}

function configSortScore(row) {
  const rankScore = Number.isFinite(row.rankDelta20) ? Math.min(row.rankDelta20 / 1000, 3) : 0;
  const boardScore = Number.isFinite(row.bestBoardRet5) ? row.bestBoardRet5 * 10 : 0;
  const relScore = Number.isFinite(row.relativeRet5) ? row.relativeRet5 * 10 : 0;
  return rankScore + boardScore + relScore;
}

function evaluateEvents(rows, market, horizonKey) {
  const returns = rows.map((row) => row[horizonKey]).filter(Number.isFinite);
  const own = summarizeReturns(returns);
  const byDate = groupBy(
    rows.filter((row) => Number.isFinite(row[horizonKey])),
    (row) => row.signalDate,
  );
  let randomAvgNumerator = 0;
  let randomWinNumerator = 0;
  let randomWeight = 0;
  for (const [date, items] of byDate.entries()) {
    const daily = market.dailyStats(date, horizonKey);
    if (!Number.isFinite(daily.avg) || !Number.isFinite(daily.winRate)) continue;
    randomAvgNumerator += daily.avg * items.length;
    randomWinNumerator += daily.winRate * items.length;
    randomWeight += items.length;
  }
  const randomAvg = randomWeight ? randomAvgNumerator / randomWeight : null;
  const randomWinRate = randomWeight ? randomWinNumerator / randomWeight : null;
  return {
    matured: own.n,
    avg: own.avg,
    median: own.median,
    winRate: own.winRate,
    profitFactor: own.profitFactor,
    randomAvg,
    randomWinRate,
    avgExcess: Number.isFinite(own.avg) && Number.isFinite(randomAvg) ? own.avg - randomAvg : null,
    winExcess: Number.isFinite(own.winRate) && Number.isFinite(randomWinRate) ? own.winRate - randomWinRate : null,
  };
}

function summarizeReturns(values) {
  const valid = values.filter(Number.isFinite);
  const wins = valid.filter((value) => value > 0);
  const losses = valid.filter((value) => value <= 0);
  const grossGain = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  return {
    n: valid.length,
    avg: avg(valid),
    median: median(valid),
    winRate: valid.length ? wins.length / valid.length : null,
    profitFactor: grossLoss ? grossGain / grossLoss : null,
  };
}

function scoreSearchResult(result, objective = "balanced") {
  const testPenalty = result.test.matured < 15 ? -5 : 0;
  if (objective === "return") {
    const trainAvg = result.train.avgExcess || 0;
    const testAvg = result.test.avgExcess || 0;
    const fullAvg = result.full.avgExcess || 0;
    const trainWin = result.train.winExcess || 0;
    const testWin = result.test.winExcess || 0;
    const stability = Math.min(trainAvg, testAvg, fullAvg) * 220;
    return trainAvg * 180 + testAvg * 260 + fullAvg * 180 + trainWin * 60 + testWin * 80 + stability + testPenalty;
  }
  if (objective === "strict-target") {
    const trainGap =
      Math.min(result.train.winExcess || 0, result.train.avgExcess || 0) +
      Math.min(result.test.winExcess || 0, result.test.avgExcess || 0) +
      Math.min(result.full.winExcess || 0, result.full.avgExcess || 0);
    const sampleBonus = Math.min(result.full.matured / 100, 1);
    return trainGap * 240 + sampleBonus + testPenalty;
  }
  const trainScore = (result.train.winExcess || 0) * 100 + (result.train.avgExcess || 0) * 100;
  const testScore = (result.test.winExcess || 0) * 140 + (result.test.avgExcess || 0) * 100;
  const stability = Math.min(result.train.winExcess || 0, result.test.winExcess || 0) * 80;
  return trainScore + testScore + stability + testPenalty;
}

function printSearchResults(results, horizonKey) {
  console.log(`top configs, target=${horizonKey}:`);
  const table = results.map((item, index) => ({
    "#": index + 1,
    trainN: item.train.matured,
    trainDates: item.train.dateCount,
    trainWinEx: pp(item.train.winExcess),
    trainAvgEx: pp(item.train.avgExcess),
    testN: item.test.matured,
    testDates: item.test.dateCount,
    testWinEx: pp(item.test.winExcess),
    testAvgEx: pp(item.test.avgExcess),
    fullN: item.full.matured,
    fullWin: percent(item.full.winRate),
    fullWinEx: pp(item.full.winExcess),
    fullAvg: percent(item.full.avg),
    fullAvgEx: pp(item.full.avgExcess),
    attrs: item.config.attributions.join("+") || "any",
    board: item.config.boardProfile?.name || "any",
    params: compactConfig(item.config),
  }));
  console.table(table);
}

function compactConfig(config) {
  const pctRange = (min, max) => `${Math.round(min * 100)}..${Math.round(max * 100)}%`;
  return [
    `rank ${config.rankMin}-${config.rankMax}`,
    `up ${config.rankDeltaMin}+`,
    `amt ${config.amountMin}-${config.amountMax}`,
    `s5 ${pctRange(config.stockPrev5Min, config.stockPrev5Max)}`,
    `b5 ${pctRange(config.boardRet5Min, config.boardRet5Max)}`,
    `bamt ${config.boardAmountMin}-${config.boardAmountMax}`,
    config.boardProfile ? `board ${config.boardProfile.name}` : "board any",
    config.maxPerDate ? `top${config.maxPerDate}/d` : "all",
  ].join("; ");
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function between(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function avg(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function median(values) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

function num(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function int(value) {
  const parsed = num(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function percent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "-";
}

function pp(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}pp` : "-";
}
