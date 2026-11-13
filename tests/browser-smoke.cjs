// Exercise the real static file in Chromium through its debugging pipe.
// No test server, browser package, or npm dependencies are needed.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const directory = path.resolve(__dirname, "..");
const siteURL = process.env.DAILY_SITE_URL || pathToFileURL(path.join(directory, "index.html")).href;
const browserPath = process.env.BROWSER_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = mkdtempSync(path.join(tmpdir(), "daily-browser-test-"));
const child = spawn(browserPath, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-crash-reporter", `--user-data-dir=${profile}`, "--remote-debugging-pipe"], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
const pending = new Map();
const exceptions = [];
let id = 0;
let sessionId;
let buffer = "";
let browserErrors = "";
child.stderr.on("data", data => { browserErrors += data.toString(); });
child.on("error", error => { for (const request of pending.values()) request.reject(error); });
child.on("exit", (code, signal) => {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error(`Browser exited (${signal || code}): ${browserErrors.slice(-2000)}`));
  }
  pending.clear();
});
child.stdio[4].on("data", data => {
  buffer += data.toString();
  let end;
  while ((end = buffer.indexOf("\0")) !== -1) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text);
    if (pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
  }
});

function send(method, params = {}, session = sessionId) {
  return new Promise((resolve, reject) => {
    const current = ++id;
    const timer = setTimeout(() => { pending.delete(current); reject(new Error(`Timed out: ${method}. ${browserErrors.slice(-1000)}`)); }, process.env.DAILY_SITE_URL ? 70000 : 12000);
    pending.set(current, { resolve, reject, timer });
    child.stdio[3].write(JSON.stringify({ id: current, method, params, ...(session ? { sessionId: session } : {}) }) + "\0");
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function until(expression) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Condition didn't become true: ${expression}`);
}

async function importJSON(data) {
  await evaluate(`document.getElementById('add-source').click(); (() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(JSON.stringify(data))}], 'test.json', {type:'application/json'}));
    const input = document.getElementById('index-file');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
}

(async () => {
  try {
    const target = await send("Target.createTarget", { url: "about:blank" }, null);
    sessionId = (await send("Target.attachToTarget", { targetId: target.targetId, flatten: true }, null)).sessionId;
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: siteURL + "?date=2026-10-01" });
    await until("document.getElementById('video-card')?.getAttribute('aria-busy') === 'false'");
    assert.equal(await evaluate("document.getElementById('watch-link').href"), "https://www.youtube.com/watch?v=DAIyRVxrjP4");
    assert.equal(await evaluate("document.getElementById('video-count').textContent"), "586");
    if (await evaluate("Boolean(window.DAILY_SITE_CONFIG?.metadata_base)")) {
      const hosted = await evaluate(`(async () => {
        const [id, entry] = Object.entries(window.DAILY_INDEX_MANIFEST.items).find(([, item]) => item.status === 'ready');
        const library = await window.DailyBundles.load(id);
        const archive = await window.DailyData.metadata('DAIyRVxrjP4');
        return {count: library.videos.length, expected: entry.count, id: archive.metadata.id};
      })()`);
      assert.equal(hosted.count, hosted.expected);
      assert.equal(hosted.id, "DAIyRVxrjP4");
      const downloads = path.join(profile, "downloads");
      mkdirSync(downloads);
      await send("Browser.setDownloadBehavior", {behavior: "allow", downloadPath: downloads}, null);
      await evaluate("document.getElementById('video-metadata-download').click()");
      const downloaded = path.join(downloads, "DAIyRVxrjP4.json");
      const deadline = Date.now() + 10000;
      while (!existsSync(downloaded) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(JSON.parse(readFileSync(downloaded, "utf8")).metadata.id, "DAIyRVxrjP4");
    }
    await evaluate("document.getElementById('browse-suggestions').click(); document.getElementById('suggestion-search').value = 'Mossy Earth'; document.getElementById('suggestion-search').dispatchEvent(new Event('input'));");
    await until("document.querySelectorAll('.suggestion-card').length === 1");
    assert.equal(await evaluate("document.querySelectorAll('.suggestion-card').length"), 1, JSON.stringify({
      state: await evaluate("({url: location.href, query: document.getElementById('suggestion-search').value, category: document.getElementById('suggestion-category').value, added: document.getElementById('suggestion-new-only').checked, count: document.getElementById('suggestion-results-count').textContent})"), exceptions,
    }));
    // Inject a fixture bundle to exercise the one-tap flow without contacting YouTube.
    await evaluate(`(() => {
      const item = window.DAILY_SUGGESTIONS.items.find(item => item.name === 'Mossy Earth');
      const index = {version:1, source_type:'channel', source_url:item.url+'/videos', source_title:'Mossy Earth', channel_id:'UC1OLx7nzJgIqwpDzFFrTuLA', fetched_at:'2026-10-01T00:00:00Z', videos:[{id:'abcdefghijk',title:'Fixture video'}]};
      window.DAILY_INDEX_MANIFEST.items[item.id] = {status:'ready', path:'data/indexes/'+item.id+'.js', source_url:index.source_url, count:1};
      window.DAILY_INDEXES[item.id] = index;
      document.getElementById('suggestion-search').dispatchEvent(new Event('input'));
    })()`);
    await evaluate("document.querySelector('.suggestion-card button').click()");
    await until("document.getElementById('source-link').textContent === 'Mossy Earth' && document.getElementById('video-card').getAttribute('aria-busy') === 'false'");
    assert.equal(await evaluate("document.getElementById('import-dialog').open"), false);
    assert.equal(await evaluate("document.getElementById('source-count').textContent"), '2');
    await evaluate("document.getElementById('remove-index').click(); document.getElementById('confirm-remove').click()");
    await until("document.getElementById('source-count').textContent === '1'");
    await evaluate("document.getElementById('browse-suggestions').click(); document.getElementById('suggestion-search').value = ''; document.getElementById('suggestion-search').dispatchEvent(new Event('input')); document.getElementById('suggestion-new-only').click();");
    assert.equal(await evaluate("document.getElementById('suggestion-results-count').textContent"), "1–24 of 29 suggestions");
    await evaluate("document.getElementById('suggestions-dialog').close()");
    mkdirSync(path.join(directory, "test-results"), { recursive: true });
    const desktop = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(path.join(directory, "test-results/desktop.png"), Buffer.from(desktop.data, "base64"));

    await evaluate("document.getElementById('next-day').click()");
    await until("document.getElementById('pick-date').value === '2026-10-02' && document.getElementById('video-card').getAttribute('aria-busy') === 'false'");
    assert.notEqual(await evaluate("document.getElementById('watch-link').href"), "https://www.youtube.com/watch?v=DAIyRVxrjP4");
    await evaluate("document.getElementById('previous-day').click()");
    await until("document.getElementById('watch-link').href.endsWith('DAIyRVxrjP4')");

    await importJSON({ broken: true });
    await until("!document.getElementById('import-error').hidden");
    assert.equal(await evaluate("document.getElementById('source-count').textContent"), "1");
    await evaluate("document.getElementById('import-dialog').close()");

    const playlist = {
      version: 1, source_type: "playlist", source_url: "https://www.youtube.com/playlist?list=PLtest123", source_title: "My test playlist", fetched_at: "2026-10-01T00:00:00Z",
      metadata_status: "complete", metadata_version: 1, playlist_status: "complete", metadata_updated_at: "2026-10-01T00:00:00Z",
      videos: [{ id: "abcdefghijk", title: '<img src=x onerror="alert(1)"> stays text', upload_date: "2024-02-29", view_count: 12000, like_count: 0, duration: 243, description: "An enriched fixture description.", tags: ["science"], metadata_fetched_at: "2026-10-01T00:00:00Z" }],
      playlists: [{ id: "PLtest123", title: "Science <script> stays text", description: "A fixture playlist.", status: "complete", fetched_at: "2026-10-01T00:00:00Z", video_ids: ["abcdefghijk"] }],
    };
    await importJSON(playlist);
    await until("document.getElementById('source-count').textContent === '2' && document.getElementById('source-type').textContent === 'PLAYLIST'");
    assert.equal(await evaluate("document.getElementById('video-title').textContent"), playlist.videos[0].title);
    assert.equal(await evaluate("document.querySelectorAll('#video-title img').length"), 0);
    assert.equal(await evaluate("document.querySelectorAll('#upload-chart .chart-bar').length"), 1);
    assert.equal(await evaluate("document.querySelectorAll('#video-playlists .playlist-chip').length"), 1);
    assert.equal(await evaluate("document.querySelectorAll('#playlist-grid script').length"), 0);
    assert.match(await evaluate("document.getElementById('video-facts').textContent"), /Feb 29, 2024/);
    await evaluate("document.querySelector('[data-metric=like_count]').click()");
    assert.match(await evaluate("document.querySelector('#upload-chart .chart-bar').getAttribute('aria-label')"), /0 likes/);
    await evaluate("document.querySelector('[data-metric=view_count]').click()");
    assert.match(await evaluate("document.getElementById('chart-explanation').textContent"), /not views earned/);
    await evaluate("document.getElementById('playlist-search').value = 'absent'; document.getElementById('playlist-search').dispatchEvent(new Event('input'))");
    assert.equal(await evaluate("document.querySelectorAll('.playlist-card').length"), 0);
    await evaluate("document.getElementById('playlist-search').value = ''; document.getElementById('playlist-search').dispatchEvent(new Event('input'))");
    assert.equal(await evaluate("document.querySelectorAll('.playlist-card').length"), 1);
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 1050, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
    await evaluate("document.getElementById('insights').scrollIntoView()");
    const insights = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(path.join(directory, "test-results/insights-mobile.png"), Buffer.from(insights.data, "base64"));
    await send("Page.reload");
    await until("document.getElementById('source-type')?.textContent === 'PLAYLIST'");
    assert.equal(await evaluate("document.getElementById('source-count').textContent"), "2");

    await evaluate("document.getElementById('remove-index').click(); document.getElementById('confirm-remove').click()");
    await until("document.getElementById('source-count').textContent === '1'");
    await evaluate("document.getElementById('remove-index').click(); document.getElementById('confirm-remove').click()");
    await until("!document.getElementById('empty-state').hidden");
    await evaluate("document.getElementById('restore-example').click()");
    await until("document.getElementById('video-card').getAttribute('aria-busy') === 'false' && !document.getElementById('video-card').hidden");

    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 1050, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
    const mobile = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(path.join(directory, "test-results/mobile.png"), Buffer.from(mobile.data, "base64"));
    assert.deepEqual(exceptions, []);
    console.log("Browser checks passed: " + siteURL + ", daily/date picks, library loading, metadata, imports, charts, persistence, removal, mobile layout, and no JavaScript exceptions.");
  } finally {
    for (const request of pending.values()) clearTimeout(request.timer);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
