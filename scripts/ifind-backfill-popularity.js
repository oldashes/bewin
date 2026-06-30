#!/usr/bin/env node

const { upsertPopularitySnapshots } = require("../work/strategy-dashboard/server");

const BASE_URL = process.env.IFIND_BASE_URL || "https://quantapi.51ifind.com/api/v1";
const REFRESH_TOKEN = process.env.IFIND_REFRESH_TOKEN || "";
const FROM = normalizeDate(process.env.IFIND_BACKFILL_FROM || process.argv[2] || "2025-09-25");
const TO = normalizeDate(process.env.IFIND_BACKFILL_TO || process.argv[3] || new Date().toISOString().slice(0, 10));
const RANK_MAX = boundedInt(process.env.IFIND_RANK_MAX || process.argv[4], 1600, 1, 5000);
const LIMIT = boundedInt(process.env.IFIND_BACKFILL_LIMIT, 0, 0, 10000);
const DRY_RUN = ["1", "true", "yes"].includes(String(process.env.IFIND_DRY_RUN || "").toLowerCase());
const DELAY_MS = boundedInt(process.env.IFIND_BACKFILL_DELAY_MS, 120, 0, 10000);
const CHUNK_SIZE = 1000;

if (!REFRESH_TOKEN) {
  console.error("Missing IFIND_REFRESH_TOKEN in .env or environment.");
  process.exit(1);
}

if (!FROM || !TO || FROM > TO) {
  console.error("Invalid date range. Use IFIND_BACKFILL_FROM=YYYY-MM-DD IFIND_BACKFILL_TO=YYYY-MM-DD.");
  process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  const accessToken = await getAccessToken();
  const dates = weekdayDates(FROM, TO).slice(0, LIMIT || undefined);
  const summary = {
    from: FROM,
    to: TO,
    rankMax: RANK_MAX,
    dryRun: DRY_RUN,
    requestedDates: dates.length,
    fetchedDates: 0,
    skippedDates: 0,
    failedDates: 0,
    savedRecords: 0,
  };

  for (const date of dates) {
    const ymd = date.replaceAll("-", "");
    const searchstring = `${Number(ymd.slice(0, 4))}年${Number(ymd.slice(4, 6))}月${Number(ymd.slice(6, 8))}日沪深A股个股热度排名1到${RANK_MAX}`;
    try {
      const payload = await ifindPost("/smart_stock_picking", { searchstring, searchtype: "stock" }, accessToken);
      if (payload.errorcode === -4001 || /no data/i.test(String(payload.errmsg || ""))) {
        summary.skippedDates += 1;
        console.log(`${date} skipped: ${payload.errmsg || "no data"}`);
        await delay(DELAY_MS);
        continue;
      }
      if (payload.errorcode !== 0) {
        throw new Error(payload.errmsg || `iFind error ${payload.errorcode}`);
      }

      const records = popularityRecordsFromSmartPick(payload, date, ymd, searchstring);
      let saved = 0;
      if (!DRY_RUN) {
        for (let index = 0; index < records.length; index += CHUNK_SIZE) {
          saved += await upsertPopularitySnapshots(records.slice(index, index + CHUNK_SIZE));
        }
      }
      summary.fetchedDates += 1;
      summary.savedRecords += DRY_RUN ? records.length : saved;
      console.log(`${date} fetched ${records.length}, ${DRY_RUN ? "dry-run" : "saved"} ${DRY_RUN ? records.length : saved}`);
    } catch (error) {
      summary.failedDates += 1;
      console.log(`${date} failed: ${error.message}`);
    }
    await delay(DELAY_MS);
  }

  console.log(JSON.stringify(summary, null, 2));
}

async function getAccessToken() {
  const payload = await ifindPost("/get_access_token", null, null, { refresh_token: REFRESH_TOKEN });
  const token = payload?.data?.access_token;
  if (payload.errorcode !== 0 || !token) {
    throw new Error(`iFind access token failed: ${payload.errmsg || payload.errorcode || "unknown error"}`);
  }
  return token;
}

async function ifindPost(path, body, accessToken, extraHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  if (accessToken) headers.access_token = accessToken;
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`iFind ${path} returned non-JSON ${response.status}: ${text.slice(0, 120)}`);
  }
  if (!response.ok) {
    throw new Error(`iFind ${path} HTTP ${response.status}: ${payload.errmsg || text.slice(0, 120)}`);
  }
  return payload;
}

function popularityRecordsFromSmartPick(payload, date, ymd, searchstring) {
  const table = payload?.tables?.[0]?.table || {};
  const codeKey = findKey(table, "股票代码");
  const nameKey = findKey(table, "股票简称");
  const rankKey = Object.keys(table).find((key) => key.includes("个股热度排名") && !key.includes("基数") && !key.includes("名次"));
  const marketTypeKey = findKey(table, "股票市场类型");
  if (!codeKey || !rankKey) return [];

  const codes = Array.isArray(table[codeKey]) ? table[codeKey] : [];
  return codes
    .map((rawCode, index) => {
      const thscode = String(rawCode || "").trim();
      const code = thscode.match(/\d{6}/)?.[0] || "";
      const suffix = thscode.split(".").pop()?.toUpperCase() || "";
      const rank = parseRank(Array.isArray(table[rankKey]) ? table[rankKey][index] : null);
      if (!code || !Number.isFinite(rank)) return null;
      return {
        source: "ths",
        category: "stock",
        metric: "hot",
        snapshot_date: date,
        snapshot_key: `${ymd}1500-ifind`,
        snapshot_time: `${date}T15:00:00+08:00`,
        code,
        name: Array.isArray(table[nameKey]) ? String(table[nameKey][index] || "") : code,
        market: suffix === "SH" ? "17" : suffix === "SZ" ? "33" : suffix === "BJ" ? "83" : "",
        rank,
        rank_change: null,
        heat_value: null,
        pct: null,
        price: null,
        float_market_value: null,
        main_tag: "",
        raw: {
          provider: "ifind",
          thscode,
          searchstring,
          rankField: rankKey,
          rankValue: Array.isArray(table[rankKey]) ? table[rankKey][index] : null,
          marketType: Array.isArray(table[marketTypeKey]) ? table[marketTypeKey][index] : null,
        },
      };
    })
    .filter(Boolean);
}

function findKey(table, name) {
  return Object.keys(table).find((key) => key === name || key.includes(name));
}

function parseRank(value) {
  if (typeof value === "number") return value;
  const match = String(value || "").match(/\d+/);
  return match ? Number(match[0]) : null;
}

function weekdayDates(from, to) {
  const dates = [];
  const current = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (current <= end) {
    const day = current.getUTCDay();
    if (day >= 1 && day <= 5) dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function normalizeDate(value) {
  const text = String(value || "").trim().replaceAll("/", "-");
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function boundedInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
