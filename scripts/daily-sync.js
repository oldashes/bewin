#!/usr/bin/env node

const { runDailyKlineSync } = require("../work/strategy-dashboard/server");

function envAtLeast(name, min) {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(number, min) : value;
}

runDailyKlineSync({
  source: process.env.SYNC_SOURCE || "em",
  strategy: process.env.SYNC_STRATEGY || null,
  lookbackDays: process.env.SYNC_LOOKBACK_DAYS,
  maxStocks: envAtLeast("SYNC_MAX_STOCKS", 160),
  force: process.env.SYNC_FORCE,
})
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
