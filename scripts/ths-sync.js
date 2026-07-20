#!/usr/bin/env node

const { runThsPopularitySync } = require("../work/strategy-dashboard/server");

function envAtLeast(name, min) {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(number, min) : value;
}

runThsPopularitySync({
  date: process.env.THS_SYNC_DATE,
  categories: process.env.THS_HOT_CATEGORIES,
  includeAttention: process.env.THS_INCLUDE_ATTENTION,
  watchlistMax: envAtLeast("THS_WATCHLIST_MAX", 80),
  lookbackDays: process.env.THS_WATCHLIST_LOOKBACK_DAYS || process.env.SYNC_LOOKBACK_DAYS,
})
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
