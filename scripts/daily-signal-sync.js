#!/usr/bin/env node

const { runDailySignalGeneration } = require("../work/strategy-dashboard/server");

function envAtLeast(name, min) {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(number, min) : value;
}

runDailySignalGeneration({
  source: process.env.SIGNAL_SOURCE || "em",
  date: process.env.SIGNAL_DATE,
  maxUniverse: envAtLeast("SIGNAL_MAX_UNIVERSE", 240),
  rankMax: process.env.SIGNAL_RANK_MAX,
  concurrency: process.env.SIGNAL_CONCURRENCY,
  boardMode: process.env.SIGNAL_BOARD_MODE,
  force: process.env.SIGNAL_FORCE,
})
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
