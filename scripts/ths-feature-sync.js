#!/usr/bin/env node

const { runThsFeatureGeneration } = require("../work/strategy-dashboard/server");

runThsFeatureGeneration({
  date: process.env.THS_FEATURE_DATE,
  rankMax: process.env.IFIND_FEATURE_RANK_MAX,
  minRankDelta20: process.env.IFIND_FEATURE_MIN_RANK_DELTA_20,
  amountRatioMin: process.env.IFIND_FEATURE_AMOUNT_RATIO_MIN,
  amountRatioMax: process.env.IFIND_FEATURE_AMOUNT_RATIO_MAX,
  prev5MinPct: process.env.IFIND_FEATURE_PREV5_MIN_PCT,
  prev5MaxPct: process.env.IFIND_FEATURE_PREV5_MAX_PCT,
  metric: process.env.IFIND_FEATURE_METRIC,
  boardMode: process.env.IFIND_FEATURE_BOARD_MODE,
})
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
