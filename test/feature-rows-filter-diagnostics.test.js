const test = require("node:test");
const assert = require("node:assert/strict");

const { featureRowsFilterDiagnostics } = require("../work/strategy-dashboard/server");

const EARLY_PARAMS = {
  rankMin: 400,
  rankMax: 1200,
  rankDelta20Min: 1,
  amountRatioMin: 1,
  amountRatioMax: 2.5,
  stockPrev5MinPct: -20,
  stockPrev5MaxPct: 35,
  boardRet5MinPct: 3,
  boardRet5MaxPct: 15,
  boardAmountRatioMin: 1.2,
  boardAmountRatioMax: 2,
  maxPerDate: 0,
  requireStrongBoard: false,
  requireResonance: false,
};

const HOT_PARAMS = {
  ...EARLY_PARAMS,
  rankMin: 1,
  rankMax: 100,
  rankDelta20Min: 300,
  amountRatioMin: 0.8,
  amountRatioMax: 3.5,
  boardRet5MinPct: -100,
  boardRet5MaxPct: 300,
  boardAmountRatioMin: 0,
  boardAmountRatioMax: 20,
  requireStrongBoard: false,
};

function baseRow(overrides = {}) {
  return {
    rank: 500,
    rank_delta_20: 50,
    amount_ratio: 1.5,
    prev_5: 0.1,
    best_board_ret_5: 0.08,
    best_board_amount_ratio: 1.4,
    ...overrides,
  };
}

function stepMap(steps) {
  return Object.fromEntries(steps.map((step) => [step.key, step.count]));
}

test("separates missing board metrics from out-of-range boardRet5 on early", () => {
  const rows = [
    baseRow({ best_board_ret_5: null, best_board_amount_ratio: null }),
    baseRow({ best_board_ret_5: 0.08, best_board_amount_ratio: 1.4 }),
    baseRow({ best_board_ret_5: 0.25, best_board_amount_ratio: 1.4 }),
    baseRow({ best_board_ret_5: 0.01, best_board_amount_ratio: 1.4 }),
  ];

  const { steps, missingBoardMetricsCount } = featureRowsFilterDiagnostics(rows, EARLY_PARAMS, "early");
  const counts = stepMap(steps);

  assert.ok(steps.some((step) => step.key === "boardMetrics"), "boardMetrics step present for early");
  assert.equal(counts.stockPrev5, 4);
  assert.equal(counts.boardMetrics, 3, "null board metrics dropped before sweet-spot");
  assert.equal(missingBoardMetricsCount, 1);
  assert.equal(counts.boardRet5, 1, "only in-range survivor remains after boardRet5");
  assert.equal(counts.boardAmount, 1);
});

test("counts null board ret as missing even when amount ratio is present", () => {
  const rows = [
    baseRow({ best_board_ret_5: null, best_board_amount_ratio: 1.5 }),
    baseRow({ best_board_ret_5: 0.05, best_board_amount_ratio: 1.5 }),
  ];
  const { steps, missingBoardMetricsCount } = featureRowsFilterDiagnostics(rows, EARLY_PARAMS, "early");
  const counts = stepMap(steps);
  assert.equal(counts.boardMetrics, 1);
  assert.equal(missingBoardMetricsCount, 1);
  assert.equal(counts.boardRet5, 1);
});

test("hot wide-open bypass skips boardMetrics step and keeps null board rows", () => {
  const rows = [
    baseRow({
      rank: 10,
      rank_delta_20: 400,
      amount_ratio: 1.2,
      best_board_ret_5: null,
      best_board_amount_ratio: null,
    }),
    baseRow({
      rank: 20,
      rank_delta_20: 400,
      amount_ratio: 1.2,
      best_board_ret_5: 0.5,
      best_board_amount_ratio: 3,
    }),
  ];
  const { steps, missingBoardMetricsCount } = featureRowsFilterDiagnostics(rows, HOT_PARAMS, "hot");
  assert.equal(
    steps.some((step) => step.key === "boardMetrics"),
    false,
    "hot bypass should not add boardMetrics step",
  );
  assert.equal(missingBoardMetricsCount, 0);
  const counts = stepMap(steps);
  assert.equal(counts.boardRet5, 2);
  assert.equal(counts.boardAmount, 2);
});

test("bottleneck prefers boardMetrics when missing metrics cause the largest drop", () => {
  const rows = Array.from({ length: 10 }, (_, index) =>
    baseRow({
      best_board_ret_5: index < 8 ? null : 0.08,
      best_board_amount_ratio: index < 8 ? null : 1.4,
    }),
  );
  const { steps, missingBoardMetricsCount } = featureRowsFilterDiagnostics(rows, EARLY_PARAMS, "early");
  assert.equal(missingBoardMetricsCount, 8);

  const bottleneck =
    steps
      .slice(1)
      .map((step, index) => {
        const previous = steps[index].count;
        return { ...step, previous, dropped: Math.max(0, previous - step.count) };
      })
      .filter((step) => step.dropped > 0)
      .sort((a, b) => b.dropped - a.dropped || a.count - b.count)[0] || null;

  assert.equal(bottleneck?.key, "boardMetrics");
  assert.equal(bottleneck?.dropped, 8);
});
