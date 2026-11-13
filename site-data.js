/* Read the compressed publishing format without changing the saved library format. */
(function (root) {
  "use strict";
  function shardKey(id) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error("Invalid video ID.");
    return [...id.slice(0, 2)].map(character => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  }
  async function readJSON(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error("Couldn't load the saved data. Please try again.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Some hosts apply Content-Encoding themselves; only decompress actual gzip bytes.
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof DecompressionStream === "undefined") throw new Error("Please update your browser to load this library.");
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      return new Response(stream).json();
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  let savedKey, savedRequest;
  async function metadata(id) {
    const key = shardKey(id);
    const base = root.DAILY_SITE_CONFIG?.metadata_base;
    if (!base) return readJSON(`data/metadata/videos/${id}.json`);
    if (key !== savedKey) {
      savedKey = key;
      const request = readJSON(`${base}/videos/${key}.json.gz`);
      savedRequest = request;
      request.catch(() => { if (savedRequest === request) savedKey = undefined; });
    }
    const archive = (await savedRequest)[id];
    if (!archive || archive.metadata?.id !== id) throw new Error("This video's full metadata is not available.");
    return archive;
  }
  const api = { shardKey, readJSON, metadata };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DailyData = api;
})(globalThis);
