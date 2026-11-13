const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync, existsSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createLoader } = require("../bundled-indexes.js");
const Core = require("../core.js");
const sample = Core.normalizeIndex(require("../data/geography-now.json"));
const id = "a".repeat(16);
const manifest = { version: 1, items: { [id]: {
  status: "ready", path: `data/indexes/${id}.js`, source_url: sample.source_url, count: sample.videos.length,
} } };

test("bundled libraries are lazy, concurrent reads share one load, and callers get independent copies", async () => {
  let reads = 0;
  const loader = createLoader(manifest, async () => { reads++; return sample; }, Core.normalizeIndex);
  assert.equal(reads, 0);
  const [a, b] = await Promise.all([loader.load(id), loader.load(id)]);
  assert.equal(reads, 1);
  assert.equal((await Core.pick(a, "2026-10-01")).id, "DAIyRVxrjP4");
  a.videos.pop();
  assert.equal(b.videos.length, 586);
});

test("missing, external, or mismatched bundles cannot silently become libraries", async () => {
  const bad = { version: 1, items: { [id]: { ...manifest.items[id], path: "https://example.com/evil.js" } } };
  const loader = createLoader(bad, () => { throw new Error("Must not load"); }, Core.normalizeIndex);
  assert.equal(loader.entry(id), null);
  await assert.rejects(loader.load(id), /not been bundled/);
  const mismatched = createLoader(manifest, async () => ({ ...sample, source_url: "https://www.youtube.com/@different/videos" }), Core.normalizeIndex);
  await assert.rejects(mismatched.load(id), /does not match/);
});

test("a failed download can be retried", async () => {
  let attempts = 0;
  const loader = createLoader(manifest, async () => {
    if (++attempts === 1) throw new Error("Network failed");
    return sample;
  }, Core.normalizeIndex);
  await assert.rejects(loader.load(id), /Network failed/);
  assert.equal((await loader.load(id)).videos.length, 586);
  assert.equal(attempts, 2);
});

test("compressed hosted indexes retain source and count validation", async () => {
  const compressed = {version: 1, items: {[id]: {...manifest.items[id], path: `data/indexes/${id}.json.gz`}}};
  const loader = createLoader(compressed, async (key, file) => {
    assert.equal(file, `data/indexes/${key}.json.gz`);
    return sample;
  }, Core.normalizeIndex);
  assert.equal((await loader.load(id)).videos.length, sample.videos.length);
  compressed.items[id].path = `../data/indexes/${id}.json.gz`;
  assert.equal(loader.entry(id), null);
});

test("every ready manifest entry has a valid matching file; every catalog source has a status", {
  skip: !existsSync(path.resolve(__dirname, "../data/indexes")) && "Local collection files are not present",
}, async () => {
  const root = path.resolve(__dirname, "..");
  const context = { window: {} };
  vm.runInNewContext(readFileSync(path.join(root, "indexes-manifest.js"), "utf8"), context);
  const published = context.window.DAILY_INDEX_MANIFEST;
  const catalog = require("../data/suggestions.json");
  assert.deepEqual(Object.keys(published.items).sort(), catalog.items.map(item => item.id).sort());
  for (const [key, entry] of Object.entries(published.items)) {
    assert.ok(["ready", "pending", "missing_url", "failed"].includes(entry.status));
    if (entry.status !== "ready") continue;
    assert.equal(entry.path, `data/indexes/${key}.js`);
    vm.runInNewContext(readFileSync(path.join(root, entry.path), "utf8"), context);
    const loader = createLoader(published, async itemId => context.window.DAILY_INDEXES[itemId], Core.normalizeIndex);
    assert.equal((await loader.load(key)).videos.length, entry.count);
  }
});
