const assert = require("node:assert/strict");
const { test } = require("node:test");
const { gzipSync } = require("node:zlib");
const Data = require("../site-data.js");

test("compressed data loads losslessly with either raw gzip or host-decoded JSON", async () => {
  const original = global.fetch;
  const value = {title: "Geografía 🌎", observations: [{view_count: 0}], description: "<script> stays data"};
  try {
    for (const body of [gzipSync(JSON.stringify(value)), JSON.stringify(value)]) {
      global.fetch = async () => new Response(body);
      assert.deepEqual(await Data.readJSON("data/indexes/fixture.json.gz"), value);
    }
    global.fetch = async () => new Response("missing", {status: 404});
    await assert.rejects(Data.readJSON("missing"), /Couldn't load/);
  } finally { global.fetch = original; }
});

test("archive shards distinguish case and reject malformed video identifiers", () => {
  assert.equal(Data.shardKey("AA123456789"), "4141");
  assert.equal(Data.shardKey("Aa123456789"), "4161");
  assert.throws(() => Data.shardKey("../secrets"), /Invalid video/);
});

test("metadata retrieval retries failed shards and verifies the requested video", async () => {
  const original = global.fetch;
  global.DAILY_SITE_CONFIG = {metadata_base: "https://example.com/archive"};
  const id = "Ab123456789";
  let calls = 0;
  try {
    global.fetch = async url => {
      assert.equal(url, "https://example.com/archive/videos/4162.json.gz");
      if (++calls === 1) return new Response("missing", {status: 404});
      return new Response(gzipSync(JSON.stringify({[id]: {metadata: {id}, observations: []}})));
    };
    await assert.rejects(Data.metadata(id));
    assert.equal((await Data.metadata(id)).metadata.id, id);
    assert.equal(calls, 2);
    await assert.rejects(Data.metadata("Ab987654321"), /not available/);
  } finally { global.fetch = original; delete global.DAILY_SITE_CONFIG; }
});
