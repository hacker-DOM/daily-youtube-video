const assert = require("node:assert/strict");
const {test} = require("node:test");
const Core = require("../core.js");
const Insights = require("../insights.js");
const base = require("../data/geography-now.json");
const fixture = () => Core.normalizeIndex({...base, metadata_version: 1, metadata_status: "partial", playlist_status: "complete",
  videos: [
    {id: "aaaaaaaaaaa", title: "First", upload_date: "2024-01-01", view_count: 120, like_count: 0, duration: 200, metadata_status: "complete", description: "Full text", tags: ["science"], metadata_path: "data/metadata/videos/aaaaaaaaaaa.json"},
    {id: "bbbbbbbbbbb", title: "Second", upload_date: "2024-01-20", view_count: 80},
    {id: "ccccccccccc", title: "Unknown counts", upload_date: "2024-03-01"},
    {id: "ddddddddddd", title: "Undated", view_count: 999},
  ], playlists: [{id: "PLfixture", title: "A series", description: "Playlist description", status: "complete", video_ids: ["aaaaaaaaaaa", "eeeeeeeeeee", "aaaaaaaaaaa"], fetched_at: "2026-10-01T12:00:00Z"}],
});

test("metadata survives normalization, daily selection, export and reimport", async () => {
  const index = fixture();
  assert.deepEqual(Core.normalizeIndex(JSON.parse(JSON.stringify(index))), index);
  const picked = await Core.pick(index, "2026-10-01");
  assert.deepEqual(picked, {...index.videos[picked.index], index: picked.index, count: 4, date: "2026-10-01"});
  assert.deepEqual(index.videos[0].tags, ["science"]);
  assert.equal(index.playlists[0].description, "Playlist description");
});

test("monthly chart includes empty months but excludes undated videos", () => {
  const data = Insights.series(fixture(), {interval: "month"});
  assert.deepEqual(data.rows.map(row => [row.key, row.value]), [["2024-01", 2], ["2024-02", 0], ["2024-03", 1]]);
  assert.equal(data.dated, 3); assert.equal(data.total, 4);
});

test("view/like cohorts distinguish hidden counts, true zeros, and partial totals", () => {
  const views = Insights.series(fixture(), {interval: "month", metric: "view_count"});
  assert.deepEqual(views.rows.map(row => row.value), [200, 0, null]);
  const likes = Insights.series(fixture(), {interval: "month", metric: "like_count"});
  assert.equal(likes.rows[0].value, 0);
  assert.equal(likes.rows[0].missing, 1);
  assert.equal(likes.rows[2].value, null);
  assert.equal(likes.known, 1);
});

test("range filters, year grouping, and summary coverage use publication dates", () => {
  const index = fixture();
  const filtered = Insights.series(index, {from: "2024-02-01", to: "2024-12-31"});
  assert.equal(filtered.rows[0].value, 1);
  assert.equal(Insights.series(index, {from: "2025-01-01"}).rows.length, 0);
  assert.deepEqual(Insights.summary(index).view_count, {total: 1199, known: 3});
  assert.equal(Insights.summary(index).first, "2024-01-01");
});

test("playlist memberships include only matching lists, even with repeated or foreign videos", () => {
  const index = fixture();
  assert.equal(Insights.memberships(index, "aaaaaaaaaaa").length, 1);
  assert.equal(Insights.memberships(index, "bbbbbbbbbbb").length, 0);
  assert.equal(index.playlists[0].video_count, 3);
});

test("untrusted metadata cannot inject script URLs, invalid dates or negative counts", () => {
  const raw = {...base, videos: [{id: "aaaaaaaaaaa", title: "Safe", upload_date: "2026-02-30", view_count: -5,
    like_count: null, metadata_path: "https://evil.example/evil.js", tags: ["one", {}]}]};
  const video = Core.normalizeIndex(raw).videos[0];
  assert.equal(video.upload_date, undefined); assert.equal(video.view_count, undefined);
  assert.equal(video.like_count, undefined); assert.equal(video.metadata_path, undefined);
  assert.deepEqual(video.tags, ["one"]);
  assert.throws(() => Core.normalizeIndex({...raw, playlists: [{id: "../../bad", title: "bad", video_ids: []}]}), /playlist metadata/);
  assert.throws(() => Core.normalizeIndex({...raw, playlists: [{id: "PLgood", title: "bad", video_ids: ["bad"]}]}), /playlist metadata/);
});

test("old indexes still work and show missing metadata rather than fabricated charts", () => {
  const legacy = {...base, videos: base.videos.map(({id, title}) => ({id, title}))};
  const data = Insights.series(Core.normalizeIndex(legacy));
  assert.equal(data.rows.length, 0); assert.equal(data.dated, 0); assert.equal(data.total, 586);
  assert.equal(Insights.summary(Core.normalizeIndex(legacy)).view_count.known, 0);
});
