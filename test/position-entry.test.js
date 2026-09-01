const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyCurrentRanksToHistories,
  displayEmCode,
  displayMarketPrefix,
  eastmoneyCurrentRanksToSnapshots,
  normalizePositionEntry,
  normalizeStock,
  rankHistoryContainsDate,
  selectMissingRankCandidates,
} = require("../work/strategy-dashboard/server");

test("normalizes position entry aliases to nextOpen, close, and open", () => {
  assert.equal(normalizePositionEntry("nextOpen"), "nextOpen");
  assert.equal(normalizePositionEntry("next_open"), "nextOpen");
  assert.equal(normalizePositionEntry("next-open"), "nextOpen");
  assert.equal(normalizePositionEntry("Next Open"), "nextOpen");
  assert.equal(normalizePositionEntry("close"), "close");
  assert.equal(normalizePositionEntry("same_close"), "close");
  assert.equal(normalizePositionEntry("same-close"), "close");
  assert.equal(normalizePositionEntry("open"), "open");
  assert.equal(normalizePositionEntry("same_open"), "open");
  assert.equal(normalizePositionEntry("sameOpen"), "open");
  assert.equal(normalizePositionEntry(""), "nextOpen");
  assert.equal(normalizePositionEntry(undefined), "nextOpen");
  assert.equal(normalizePositionEntry("unknown_value"), "nextOpen");
});

test("uses BJ display codes for Beijing listings without changing rank API prefixes", () => {
  assert.equal(displayMarketPrefix("430047"), "BJ");
  assert.equal(displayMarketPrefix("830799"), "BJ");
  assert.equal(displayMarketPrefix("920002"), "BJ");
  assert.equal(displayEmCode("830799"), "BJ830799");
  assert.equal(displayEmCode("600519"), "SH600519");
  assert.equal(displayEmCode("300458"), "SZ300458");
  assert.equal(normalizeStock("830799").em, "BJ830799");
});

test("maps a successful getAllCurrentList payload into target-date popularity snapshots", () => {
  const rows = eastmoneyCurrentRanksToSnapshots(
    [
      { code: "600519", name: "贵州茅台", rank: 1, rankChange: -2 },
      { code: "830799", rank: 12 },
      { code: "bad", rank: 3 },
    ],
    "2026-09-01",
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, "em");
  assert.equal(rows[0].category, "stock");
  assert.equal(rows[0].metric, "rank");
  assert.equal(rows[0].snapshot_date, "2026-09-01");
  assert.equal(rows[0].snapshot_key, "20260901");
  assert.equal(rows[0].code, "600519");
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[1].code, "830799");
  assert.equal(rows[1].rank, 12);
});

test("injects live board ranks so the target date is present before history shards run", () => {
  const histories = new Map([["600519", [{ date: "2026-08-31", rank: 8 }]]]);
  applyCurrentRanksToHistories(
    histories,
    [{ code: "600519", rank: 3 }, { code: "000001", rank: 9 }],
    "2026-09-01",
  );

  assert.equal(rankHistoryContainsDate(histories.get("600519"), "2026-09-01"), true);
  assert.equal(rankHistoryContainsDate(histories.get("000001"), "2026-09-01"), true);
  assert.equal(histories.get("600519").at(-1).rank, 3);
});

test("rank resume prefers leftover codes from the previous cron shard", () => {
  const universe = [
    { code: "000001", universePriority: 1 },
    { code: "000002", universePriority: 1 },
    { code: "600519", universePriority: 1 },
  ];
  const histories = new Map([
    ["000001", [{ date: "2026-09-01", rank: 20 }]],
  ]);
  const selected = selectMissingRankCandidates(universe, histories, "2026-09-01", {
    maxFetch: 1,
    prioritizeCodes: ["600519"],
  });

  assert.equal(selected.missingCandidates.length, 2);
  assert.equal(selected.candidates.length, 1);
  assert.equal(selected.candidates[0].code, "600519");
});
