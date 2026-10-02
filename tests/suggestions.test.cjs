const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const vm = require("node:vm");
const Suggestions = require("../suggestions.js");
const catalog = require("../data/suggestions.json");
const diff = require("../data/catalog-diff.json");

test("catalog covers the provided channel and playlist list", () => {
  assert.equal(catalog.items.length, 590);
  assert.equal(catalog.categories.length, 32);
  assert.equal(catalog.items.filter(item => item.kind === "playlist").length, 6);
  assert.equal(new Set(catalog.items.map(item => item.id)).size, catalog.items.length);
  assert.equal(Suggestions.filter(catalog.items, { addedOnly: true }).length, 29);
  assert.equal(catalog.items.some(item => item.name === "Scrimba"), false);
  assert.deepEqual(diff.absent_from_paste.map(row => row.name).sort(), ["Outline", "Soap2Day"]);
});

test("same-name channels remain separate, shared playlists retain aliases", () => {
  const physics = catalog.items.filter(item => item.name === "Physics Explained");
  assert.equal(physics.length, 2);
  assert.notEqual(physics[0].url, physics[1].url);
  const travel = Suggestions.filter(catalog.items, { query: "c90adventures" });
  assert.equal(travel.length, 1);
  assert.equal(travel[0].kind, "playlist");
  assert.deepEqual(travel[0].categories, ["Outdoors", "Travel"]);
  const tasting = Suggestions.filter(catalog.items, { query: "Tasting History" });
  assert.equal(tasting.length, 1);
  assert.deepEqual(tasting[0].categories, ["Cooking", "History"]);
});

test("filters search categories, aliases, descriptions, and accents together", () => {
  assert.equal(Suggestions.filter(catalog.items, { query: "lineman", category: "Blue Collar", addedOnly: true })[0].name, "Bobsdecline");
  assert.equal(Suggestions.filter(catalog.items, { query: "electronicos" })[0].name, "Electrónicos Fantásticos!");
  assert.equal(Suggestions.filter(catalog.items, { query: "xyz-nothing-matches" }).length, 0);
  assert.equal(Suggestions.filter(catalog.items, { query: "Branch Education", category: "General Science" }).length, 0);
  assert.equal(Suggestions.filter(catalog.items, { query: "Branch Education", category: "Engineering" }).length, 1);
});

test("missing URLs are explicit search links and not invented handles", () => {
  for (const item of catalog.items) {
    assert.equal(new URL(item.search_url).searchParams.get("search_query"), item.name);
    if (!item.url) {
      assert.equal(item.url_source, null);
      assert.equal(item.added_since_github, true);
    } else {
      assert.equal(new URL(item.url).hostname, "www.youtube.com");
      assert.ok(item.url_source);
    }
  }
});

test("all linked suggestions produce commands the Python indexer accepts", () => {
  const urls = catalog.items.flatMap(item => item.url ? [item.url] : []);
  for (const url of urls) assert.match(Suggestions.indexCommand(url), /^uv run tools\/index_source.py '/);
  const program = "import json,sys;sys.path.insert(0,sys.argv[1]);from daily_video import normalize_source;urls=json.load(sys.stdin);[normalize_source(url) for url in urls];print(len(urls))";
  const count = execFileSync("python3", ["-c", program, path.join(__dirname, "../tools")], { input: JSON.stringify(urls), encoding: "utf8" });
  assert.equal(Number(count), urls.length);
});

test("index commands reject other sites and video URLs; unsafe query text is discarded", () => {
  for (const url of ["javascript:alert(1)", "https://example.com/@channel", "https://youtube.com/watch?v=123", "https://youtu.be/123", "https://youtube.com/playlist?list=RD123", "https://youtube.com/playlist?list=PL123&list=PL456", "https://youtube.com/channel/invalid", "https://youtube.com/@"]) {
    assert.throws(() => Suggestions.indexCommand(url));
  }
  assert.equal(Suggestions.indexCommand("https://www.youtube.com/@channel?x=$(echo%20BAD)`whoami`"), "uv run tools/index_source.py 'https://www.youtube.com/@channel' --output my-library.json");
  const command = Suggestions.indexCommand("https://youtube.com/user/It'sOld");
  // shlex parses the generated command as one URL argument, including its apostrophe.
  const args = JSON.parse(execFileSync("python3", ["-c", "import sys,shlex,json;print(json.dumps(shlex.split(sys.argv[1])))", command], { encoding: "utf8" }));
  assert.equal(args.length, 6);
  assert.equal(args[3], "https://www.youtube.com/user/It'sOld");
});

test("the browser data script and JSON export stay synchronized", () => {
  const context = { window: {} };
  vm.runInNewContext(readFileSync(path.join(__dirname, "../suggestions-data.js"), "utf8"), context);
  assert.equal(JSON.stringify(context.window.DAILY_SUGGESTIONS), JSON.stringify(catalog));
});
