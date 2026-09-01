const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isHistoricalMarketTargetDate,
  shouldSkipLiveCurrentList,
} = require("../work/strategy-dashboard/server");

test("historical date does not call/apply live current list", () => {
  assert.equal(isHistoricalMarketTargetDate("2026-08-10", "2026-09-01"), true);
  assert.equal(
    shouldSkipLiveCurrentList({
      targetDate: "2026-08-10",
      latestCompletedMarketDate: "2026-09-01",
    }),
    true,
  );
  assert.equal(
    shouldSkipLiveCurrentList({
      targetDate: "2026-08-29",
      latestCompletedMarketDate: "2026-09-01",
      skipLiveCurrentList: false,
    }),
    true,
  );
});

test("latest trading day still persists current list", () => {
  assert.equal(isHistoricalMarketTargetDate("2026-09-01", "2026-09-01"), false);
  assert.equal(isHistoricalMarketTargetDate("2026-09-01", "2026-08-31"), false);
  assert.equal(
    shouldSkipLiveCurrentList({
      targetDate: "2026-09-01",
      latestCompletedMarketDate: "2026-09-01",
    }),
    false,
  );
});

test("backfill mode and skipLiveCurrentList force skip even on latest day", () => {
  assert.equal(
    shouldSkipLiveCurrentList({
      targetDate: "2026-09-01",
      latestCompletedMarketDate: "2026-09-01",
      skipLiveCurrentList: true,
    }),
    true,
  );
  assert.equal(
    shouldSkipLiveCurrentList({
      targetDate: "2026-09-01",
      latestCompletedMarketDate: "2026-09-01",
      mode: "backfill",
    }),
    true,
  );
  assert.equal(
    shouldSkipLiveCurrentList({
      targetDate: "2026-09-01",
      latestCompletedMarketDate: "2026-09-01",
      backfill: "1",
    }),
    true,
  );
});
