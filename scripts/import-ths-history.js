#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { upsertPopularitySnapshots } = require("../work/strategy-dashboard/server");

const ROOT = path.resolve(__dirname, "..");
const FILES = [
  {
    file: "outputs/ths-hot-stock-signal-raw-20260608-20260618.csv",
    category: "stock",
    metric: "hot",
    rankField: "rank",
    heatField: "rate",
  },
  {
    file: "outputs/ths-hot-vs-longhu-20260622-20260626-hot-raw.csv",
    category: "stock",
    metric: "hot",
    rankField: "hot_rank",
    heatField: "hot_rate",
  },
  {
    file: "outputs/ths-hot-board-history-20260608-20260626.csv",
    categoryField: "type",
    metric: "hot",
    rankField: "rank",
    heatField: "rate",
  },
];

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  let total = 0;
  for (const config of FILES) {
    const fullPath = path.join(ROOT, config.file);
    if (!fs.existsSync(fullPath)) {
      console.log(`Skip missing file: ${config.file}`);
      continue;
    }
    const rows = parseCsv(fs.readFileSync(fullPath, "utf8"));
    const records = rows.map((row) => csvRowToRecord(row, config)).filter(Boolean);
    const imported = await upsertPopularitySnapshots(records);
    total += imported;
    console.log(`Imported ${imported} popularity snapshots from ${config.file}`);
  }
  console.log(`Imported ${total} THS popularity snapshots`);
}

function csvRowToRecord(row, config) {
  const date = dateFromYmd(row.date);
  const timeKey = String(row.time || "").trim();
  const code = String(row.code || "").trim();
  if (!date || !timeKey || !code) return null;
  const category = String(config.category || row[config.categoryField] || "").trim();
  if (!category) return null;
  return {
    source: "ths",
    category,
    metric: config.metric,
    snapshot_date: date,
    snapshot_key: timeKey,
    snapshot_time: timeKeyToIso(timeKey),
    code,
    name: String(row.name || "").trim(),
    market: String(row.market || "").trim(),
    rank: int(row[config.rankField]),
    rank_change: null,
    heat_value: num(row[config.heatField]),
    pct: null,
    price: null,
    float_market_value: null,
    main_tag: String(row.concept || "").trim(),
    raw: row,
  };
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

function dateFromYmd(value) {
  const text = String(value || "").trim();
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return "";
}

function timeKeyToIso(value) {
  const text = String(value || "").trim();
  if (!/^\d{12}$/.test(text)) return null;
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:00+08:00`;
}

function num(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function int(value) {
  const result = Number.parseInt(value, 10);
  return Number.isFinite(result) ? result : null;
}
