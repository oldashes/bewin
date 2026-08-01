const test = require("node:test");
const assert = require("node:assert/strict");

const {
  featureRunCoverageIssue,
  klineRowsCoverTarget,
  normalizeStock,
  parseTencentKlineRows,
  strategyCoverageIssue,
} = require("../work/strategy-dashboard/server");

test("parses Tencent enriched qfq daily bars", () => {
  const rows = parseTencentKlineRows({
    qfqday: [
      ["2026-07-28", "39.88", "39.31", "41.03", "39.01", "795757", {}, "9.77", "318104.04", ""],
      ["2026-07-29", "39.32", "39.74", "42.95", "38.77", "1116262", {}, "13.71", "454540.93", ""],
    ],
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[1].date, "2026-07-29");
  assert.equal(rows[1].amount, 4545409300);
  assert.equal(rows[1].turnover, 13.71);
  assert.ok(Math.abs(rows[1].pct - 1.093868) < 0.00001);
  assert.ok(Math.abs(rows[1].amplitude - 10.633426) < 0.00001);
});

test("recognizes Beijing Stock Exchange symbols", () => {
  assert.equal(normalizeStock("920002").market, "BJ");
  assert.equal(normalizeStock("BJ920002").market, "BJ");
  assert.equal(normalizeStock("688361").market, "SH");
  assert.equal(normalizeStock("300458").market, "SZ");
});

test("uses index day rows when adjusted rows are unavailable", () => {
  const rows = parseTencentKlineRows({
    qfqday: [],
    day: [["2026-07-29", "4582.09", "4600.26", "4626.71", "4516.32", "248082357", {}, "0.74", "83677927.84"]],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].close, 4600.26);
  assert.equal(rows[0].amount, 836779278400);
});

test("accepts a recent prior trading day but rejects stale K-line coverage", () => {
  const rows = [{ date: "2026-07-29" }];

  assert.equal(klineRowsCoverTarget(rows, "2026-07-01", "2026-07-30"), true);
  assert.equal(klineRowsCoverTarget(rows, "2026-07-01", "2026-07-30", 0), false);
  assert.equal(klineRowsCoverTarget(rows, "2026-06-01", "2026-08-15"), false);
  assert.equal(klineRowsCoverTarget(rows, "2026-07-30", "2026-07-30"), false);
});

test("marks a zero-hit day as not computable when popularity ranks are too shallow", () => {
  const issue = strategyCoverageIssue({
    sourceKey: "ths",
    strategyLabel: "强共振收益",
    diagnostics: {
      finalCount: 0,
      rankCoverage: {
        minRank: 3,
        maxRank: 85,
        requiredMin: 400,
        requiredMax: 1200,
        inRangeCount: 0,
      },
    },
  });

  assert.equal(issue.code, "rank_coverage_too_shallow");
});

test("keeps zero hits valid when the required popularity range is covered", () => {
  const issue = strategyCoverageIssue({
    sourceKey: "em",
    strategyLabel: "强共振收益",
    diagnostics: {
      finalCount: 0,
      rankCoverage: {
        minRank: 3,
        maxRank: 1512,
        requiredMin: 400,
        requiredMax: 1200,
        inRangeCount: 15,
      },
    },
  });

  assert.equal(issue, null);
});

test("marks sparse popularity coverage invalid when the target interval has no samples", () => {
  const issue = strategyCoverageIssue({
    sourceKey: "ths",
    strategyLabel: "强共振收益",
    diagnostics: {
      finalCount: 0,
      rankCoverage: {
        count: 12,
        minRank: 3,
        maxRank: 1450,
        requiredMin: 400,
        requiredMax: 1200,
        inRangeCount: 0,
      },
    },
  });

  assert.equal(issue.code, "rank_target_range_missing");
});

test("does not interpret an absent feature run and empty feature pool as zero hits", () => {
  const issue = featureRunCoverageIssue({
    sourceKey: "em",
    selectedDate: "2026-07-31",
    featureCount: 0,
    run: null,
  });

  assert.equal(issue.code, "feature_data_missing");
});

test("accepts imported feature rows even when no generation run was recorded", () => {
  const issue = featureRunCoverageIssue({
    sourceKey: "em",
    selectedDate: "2026-06-26",
    featureCount: 120,
    run: null,
  });

  assert.equal(issue, null);
});

test("marks a feature run incomplete when generated features materially trail ranked candidates", () => {
  const issue = featureRunCoverageIssue({
    sourceKey: "em",
    selectedDate: "2026-07-15",
    featureCount: 54,
    run: {
      status: "partial",
      details: {
        rankedCandidateCount: 72,
        klineStats: { remainingTargetCount: 18 },
      },
    },
  });

  assert.equal(issue.code, "feature_coverage_partial");
  assert.match(issue.message, /54/);
  assert.match(issue.message, /72/);
});

test("accepts a nearly complete feature run", () => {
  const issue = featureRunCoverageIssue({
    sourceKey: "em",
    selectedDate: "2026-07-01",
    featureCount: 88,
    run: {
      status: "success",
      details: { rankedCandidateCount: 89 },
    },
  });

  assert.equal(issue, null);
});

test("marks an interrupted feature run incomplete even before expected counts are known", () => {
  const issue = featureRunCoverageIssue({
    sourceKey: "em",
    selectedDate: "2026-07-28",
    featureCount: 0,
    run: {
      status: "timeout",
      details: {},
    },
  });

  assert.equal(issue.code, "feature_coverage_partial");
  assert.equal(issue.level, "error");
});
