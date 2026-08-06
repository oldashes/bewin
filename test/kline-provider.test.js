const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyDataPipelineHealth,
  completedMarketDateFromTimestamp,
  eastmoneyQuoteRow,
  featureRunCoverageIssue,
  defaultCompletedMarketYmd,
  klineRowsCoverTarget,
  klineRowsProveTargetUnavailable,
  klineRowsSupportFeatures,
  normalizeStock,
  parseTencentKlineRows,
  strategyCoverageIssue,
} = require("../work/strategy-dashboard/server");

test("targets the latest completed weekday instead of the latest cached database date", () => {
  assert.equal(defaultCompletedMarketYmd(new Date("2026-08-03T01:00:00Z")), "20260731");
  assert.equal(defaultCompletedMarketYmd(new Date("2026-08-02T12:00:00Z")), "20260731");
  assert.equal(defaultCompletedMarketYmd(new Date("2026-08-03T09:00:00Z")), "20260803");
});

test("uses the market quote timestamp as the authoritative latest trading date", () => {
  const timestamp = Math.floor(new Date("2026-10-09T07:00:00Z").getTime() / 1000);
  assert.equal(completedMarketDateFromTimestamp(timestamp, "2026-10-10"), "2026-10-09");
  assert.equal(completedMarketDateFromTimestamp(timestamp, "2026-10-08"), null);
});

test("parses a completed Eastmoney batch quote only for the requested market date", () => {
  const timestamp = Math.floor(new Date("2026-08-03T07:00:00Z").getTime() / 1000);
  const record = eastmoneyQuoteRow(
    { f2: 12.5, f3: 2.04, f4: 0.25, f5: 1000, f6: 500000, f7: 3, f8: 1.2, f12: "300458", f14: "全志科技", f15: 12.8, f16: 12.1, f17: 12.2, f124: timestamp },
    normalizeStock("300458"),
    "2026-08-03",
  );

  assert.equal(record.stock.name, "全志科技");
  assert.equal(record.row.close, 12.5);
  assert.equal(eastmoneyQuoteRow({ f2: 12.5, f12: "300458", f17: 12.2, f124: timestamp }, normalizeStock("300458"), "2026-08-04"), null);
});

test("requires enough target-day history for strategy features", () => {
  const dates = Array.from({ length: 25 }, (_, index) => {
    const date = new Date("2026-07-01T00:00:00Z");
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
  const rows = dates.map((date, index) => ({
    date,
    close: 10 + index,
    amount: 100 + index,
    turnover: 1,
  }));
  const targetDate = dates.at(-1);
  const expectedTradingDates = dates.slice(-21);

  assert.equal(klineRowsSupportFeatures(rows, targetDate, expectedTradingDates), true);
  assert.equal(klineRowsSupportFeatures(rows.slice(-10), targetDate, expectedTradingDates), false);

  const threeMissing = rows.filter((row) => !expectedTradingDates.slice(3, 6).includes(row.date));
  assert.equal(klineRowsSupportFeatures(threeMissing, targetDate, expectedTradingDates), true);

  const fourMissing = rows.filter((row) => !expectedTradingDates.slice(3, 7).includes(row.date));
  assert.equal(klineRowsSupportFeatures(fourMissing, targetDate, expectedTradingDates), false);
});

test("classifies pipeline failures separately from valid strategy zero hits", () => {
  assert.equal(
    classifyDataPipelineHealth({ sourceKey: "em", snapshotCount: 300, featureCount: 0, klineCount: 300, featureRun: { status: "timeout" } }).code,
    "feature_missing",
  );
  assert.equal(
    classifyDataPipelineHealth({ sourceKey: "em", snapshotCount: 300, featureCount: 180, klineCount: 300, featureRun: { status: "success" } }).code,
    "ok",
  );
  assert.equal(
    classifyDataPipelineHealth({
      sourceKey: "em",
      snapshotCount: 300,
      featureCount: 0,
      klineCount: 300,
      featureRun: {
        status: "success",
        details: { rankedCandidateCount: 0, rankStats: {}, klineStats: {} },
      },
    }).code,
    "no_ranked_candidates",
  );
  assert.equal(
    classifyDataPipelineHealth({ sourceKey: "em", snapshotCount: 300, featureCount: 180, klineCount: 100, featureRun: { status: "success" } }).code,
    "kline_coverage_low",
  );
  assert.equal(
    classifyDataPipelineHealth({
      sourceKey: "em",
      targetDate: "2026-08-06",
      snapshotCount: 300,
      featureCount: 180,
      klineCount: 300,
      featureRun: {
        status: "success",
        details: {
          rankedCandidateCount: 100,
          klineCandidateCount: 100,
          featureCount: 100,
          rankStats: { remainingTargetCount: 0 },
          klineStats: { remainingTargetCount: 0 },
        },
      },
    }).code,
    "feature_store_mismatch",
  );
});

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

test("distinguishes a target-day trading halt from provider coverage failure", () => {
  const resumedRows = [{ date: "2026-07-24" }, { date: "2026-07-30" }];
  const staleRows = [{ date: "2026-07-24" }];

  assert.equal(klineRowsProveTargetUnavailable(resumedRows, "2026-07-29"), true);
  assert.equal(klineRowsProveTargetUnavailable(resumedRows, "2026-07-30"), false);
  assert.equal(klineRowsProveTargetUnavailable(staleRows, "2026-07-29"), false);
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

test("does not raise a global warning for a negligible K-line gap", () => {
  const issue = featureRunCoverageIssue({
    sourceKey: "em",
    selectedDate: "2026-07-29",
    featureCount: 199,
    run: {
      status: "partial",
      details: {
        rankedCandidateCount: 201,
        klineStats: { remainingTargetCount: 2 },
      },
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
