const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../core.js");
const raw = JSON.parse(readFileSync(path.join(__dirname, "../data/geography-now.json"), "utf8"));
const sample = () => Core.normalizeIndex(raw);

test("bundled Geography Now selection matches the verified Python result", async () => {
  const index = sample();
  const pick = await Core.pick(index, "2026-10-01");
  assert.equal(index.videos.length, 586);
  assert.equal(pick.index, 128);
  assert.equal(pick.id, "DAIyRVxrjP4");
});

test("large hashes use all 256 bits without numeric precision loss", async () => {
  const source = sample();
  for (const date of ["2026-10-01", "2026-10-02", "2000-02-29", "2040-12-31"]) {
    const expected = Number(BigInt("0x" + createHash("sha256").update(date).digest("hex")) % BigInt(source.videos.length));
    assert.equal((await Core.pick(source, date)).index, expected);
  }
});

test("selection and sorting agree with Python across dates", async () => {
  const program = "import json,sys; from datetime import date; sys.path.insert(0, sys.argv[1]); from daily_video import choose_video; i=json.load(open(sys.argv[2])); print(json.dumps([choose_video(i,date.fromisoformat(d))['id'] for d in sys.argv[3:]]))";
  const dates = ["2026-10-01", "2026-10-02", "2000-02-29", "2030-01-01"];
  const expected = JSON.parse(execFileSync("python3", ["-c", program, path.join(__dirname, "../tools"), path.join(__dirname, "../data/geography-now.json"), ...dates], { encoding: "utf8" }));
  const actual = await Promise.all(dates.map(async date => (await Core.pick(sample(), date)).id));
  assert.deepEqual(actual, expected);
});

test("imports deduplicate IDs and preserve Python ASCII sorting", () => {
  const source = { ...raw, videos: ["a0000000000", "_0000000000", "Z0000000000", "-0000000000", "a0000000000"].map(id => ({ id, title: id })) };
  assert.deepEqual(Core.normalizeIndex(source).videos.map(v => v.id), ["-0000000000", "Z0000000000", "_0000000000", "a0000000000"]);
});

test("legacy channel indexes and playlist indexes are accepted", () => {
  const legacy = { ...raw, channel: "Old channel" };
  delete legacy.source_title;
  delete legacy.source_type;
  assert.equal(Core.normalizeIndex(legacy).source_title, "Old channel");
  const playlist = Core.normalizeIndex({ ...raw, source_type: "playlist", source_title: "My playlist", source_url: "https://www.youtube.com/playlist?list=PL123" });
  assert.equal(playlist.source_type, "playlist");
  assert.equal(playlist.videos.length, 586);
});

test("malformed imports are rejected instead of creating biased partial indexes", () => {
  for (const value of [null, [], {}, { ...raw, version: 2 }, { ...raw, videos: [] },
    { ...raw, source_url: "javascript:alert(1)" }, { ...raw, fetched_at: "bad date" },
    { ...raw, source_type: "radio" }, { ...raw, videos: [{ id: "broken", title: "video" }] },
    { ...raw, videos: [{ id: "12345678901", title: {} }] }]) {
    assert.throws(() => Core.normalizeIndex(value));
  }
});

test("invalid dates and calendar rollover are handled", async () => {
  for (const date of ["2026-02-29", "20261001", "2026-1-1", "nonsense", "0000-01-01"]) {
    assert.equal(Core.validDate(date), false);
    await assert.rejects(Core.pick(sample(), date));
  }
  assert.equal(Core.shiftDate("2024-02-28", 1), "2024-02-29");
  assert.equal(Core.shiftDate("2026-12-31", 1), "2027-01-01");
  assert.equal(Core.shiftDate("2026-01-01", -1), "2025-12-31");
});

function datesInZone(timeZone, timestamps) {
  const program = `
    const Core = require('./core.js');
    const timestamps = JSON.parse(process.argv[1]);
    console.log(JSON.stringify(timestamps.map(value => {
      const now = new Date(value);
      return {day: Core.today(now), seconds: Core.secondsUntilMidnight(now)};
    })));
  `;
  return JSON.parse(execFileSync(process.execPath, ["-e", program, JSON.stringify(timestamps)], {
    cwd: path.join(__dirname, ".."), env: { ...process.env, TZ: timeZone }, encoding: "utf8",
  }));
}

test("today follows local midnight instead of UTC midnight", () => {
  assert.deepEqual(datesInZone("America/Guatemala", [
    "2026-10-01T23:59:59Z", "2026-10-02T00:00:00Z",
    "2026-10-02T05:59:59Z", "2026-10-02T06:00:00Z",
  ]), [
    {day: "2026-10-01", seconds: 21601}, {day: "2026-10-01", seconds: 21600},
    {day: "2026-10-01", seconds: 1}, {day: "2026-10-02", seconds: 86400},
  ]);
  assert.deepEqual(datesInZone("Asia/Tokyo", ["2026-12-31T15:00:00Z"]), [
    {day: "2027-01-01", seconds: 86400},
  ]);
});

test("local midnight countdown handles daylight saving and fractional offsets", () => {
  assert.deepEqual(datesInZone("America/New_York", [
    "2026-03-08T05:00:00Z", "2026-03-08T06:30:00Z", // Spring forward: 23-hour day.
    "2026-11-01T04:00:00Z", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z", // Repeated 1:30 a.m.
  ]), [
    {day: "2026-03-08", seconds: 23 * 3600}, {day: "2026-03-08", seconds: 21.5 * 3600},
    {day: "2026-11-01", seconds: 25 * 3600}, {day: "2026-11-01", seconds: 23.5 * 3600},
    {day: "2026-11-01", seconds: 22.5 * 3600},
  ]);
  assert.deepEqual(datesInZone("Asia/Kathmandu", ["2026-10-01T18:15:00Z"]), [
    {day: "2026-10-02", seconds: 86400},
  ]);
});

test("bundled script and importable snapshot contain exactly the same videos", () => {
  const context = { window: {} };
  vm.runInNewContext(readFileSync(path.join(__dirname, "../library.js"), "utf8"), context);
  assert.equal(JSON.stringify(context.window.DAILY_EXAMPLE), JSON.stringify(raw));
});
