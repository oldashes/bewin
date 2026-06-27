#!/usr/bin/env node

const { runDailyKlineSync } = require("../work/strategy-dashboard/server");

runDailyKlineSync({
  source: process.env.SYNC_SOURCE || "em",
  strategy: process.env.SYNC_STRATEGY || null,
  lookbackDays: process.env.SYNC_LOOKBACK_DAYS,
  maxStocks: process.env.SYNC_MAX_STOCKS,
  force: process.env.SYNC_FORCE,
})
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
