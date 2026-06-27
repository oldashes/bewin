#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const CACHE_DIR = path.join(ROOT, "work/cache/strategy-dashboard");
const OUTPUT_FILE = path.join(CACHE_DIR, "stock-meta.json");

fs.mkdirSync(CACHE_DIR, { recursive: true });

function exchangeFromCode(code, market) {
  if (String(market) === "1" || /^(6|9)/.test(code)) return "SH";
  if (/^(8|4|920)/.test(code)) return "BJ";
  return "SZ";
}

function segmentFromCode(code, name = "") {
  const st = /(^|\*)ST/.test(name);
  if (/^(688|689)/.test(code)) return { exchange: "SH", board: "科创板", priceLimitPct: st ? 0.05 : 0.2, noLimitDays: 5 };
  if (/^(300|301|302)/.test(code)) return { exchange: "SZ", board: "创业板", priceLimitPct: st ? 0.05 : 0.2, noLimitDays: 5 };
  if (/^(8|4|920)/.test(code)) return { exchange: "BJ", board: "北交所", priceLimitPct: 0.3, noLimitDays: 1 };
  if (/^6/.test(code)) return { exchange: "SH", board: "沪市主板", priceLimitPct: st ? 0.05 : 0.1, noLimitDays: 5 };
  if (/^(000|001|002|003)/.test(code)) return { exchange: "SZ", board: "深市主板", priceLimitPct: st ? 0.05 : 0.1, noLimitDays: 5 };
  return { exchange: exchangeFromCode(code), board: "其他A股", priceLimitPct: st ? 0.05 : 0.1, noLimitDays: 5 };
}

function formatListingDate(value) {
  const text = String(value || "");
  if (!/^\d{8}$/.test(text)) return null;
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://quote.eastmoney.com/center/gridlist.html",
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function loadStockMeta() {
  const fields = "f12,f13,f14,f26,f100,f102,f103";
  const fsParam = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81";
  const rows = [];
  const pageSize = 200;
  let total = Infinity;

  for (let page = 1; rows.length < total; page += 1) {
    const url =
      "https://push2.eastmoney.com/api/qt/clist/get" +
      `?pn=${page}&pz=${pageSize}&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281` +
      `&fltt=2&invt=2&fid=f3&fs=${encodeURIComponent(fsParam)}&fields=${fields}`;
    const json = await fetchJson(url);
    total = json.data?.total || 0;
    const pageRows = json.data?.diff || [];
    rows.push(...pageRows);
    if (!pageRows.length) break;
  }

  const byCode = {};
  for (const row of rows) {
    const code = row.f12;
    if (!code) continue;
    const inferred = segmentFromCode(code, row.f14);
    byCode[code] = {
      code,
      name: row.f14,
      market: String(row.f13),
      exchange: inferred.exchange,
      board: inferred.board,
      industry: row.f100 === "-" ? "" : row.f100 || "",
      region: row.f102 === "-" ? "" : row.f102 || "",
      concepts: row.f103 === "-" || !row.f103 ? [] : String(row.f103).split(",").filter(Boolean),
      listingDate: formatListingDate(row.f26),
      priceLimitPct: inferred.priceLimitPct,
      noLimitDays: inferred.noLimitDays,
      isSt: /(^|\*)ST/.test(row.f14 || ""),
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    source: "eastmoney-clist",
    total: Object.keys(byCode).length,
    byCode,
  };
}

loadStockMeta()
  .then((data) => {
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data));
    console.log(`Wrote ${data.total} stock metadata rows to ${OUTPUT_FILE}`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
