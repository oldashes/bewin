#!/usr/bin/env node

const { runDailySignalGeneration } = require("../work/strategy-dashboard/server");

runDailySignalGeneration({
  source: process.env.SIGNAL_SOURCE || "em",
  date: process.env.SIGNAL_DATE,
  maxUniverse: process.env.SIGNAL_MAX_UNIVERSE,
  rankMax: process.env.SIGNAL_RANK_MAX,
  concurrency: process.env.SIGNAL_CONCURRENCY,
  force: process.env.SIGNAL_FORCE,
})
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
