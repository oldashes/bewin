#!/usr/bin/env node

const { runThsPopularitySync } = require("../work/strategy-dashboard/server");

runThsPopularitySync({
  date: process.env.THS_SYNC_DATE,
  categories: process.env.THS_HOT_CATEGORIES,
  includeAttention: process.env.THS_INCLUDE_ATTENTION,
  watchlistMax: process.env.THS_WATCHLIST_MAX,
  lookbackDays: process.env.THS_WATCHLIST_LOOKBACK_DAYS || process.env.SYNC_LOOKBACK_DAYS,
})
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
