/* Shared by the static page and Node's built-in test runner. */
(function (root) {
  "use strict";
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

  function normalizeIndex(raw) {
    if (!raw || raw.version !== 1 || !Array.isArray(raw.videos) || !raw.videos.length) {
      throw new Error("Choose a video index JSON file containing a nonempty videos list.");
    }
    const url = new URL(raw.source_url);
    if (url.protocol !== "https:" || !["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) {
      throw new Error("The index must have a valid YouTube source URL.");
    }
    const type = raw.source_type || (url.pathname === "/playlist" ? "playlist" : "channel");
    const title = raw.source_title || raw.channel;
    if (!["channel", "playlist"].includes(type) || typeof title !== "string" || !title.trim()) {
      throw new Error("The index needs a source title and a channel or playlist type.");
    }
    if (typeof raw.fetched_at !== "string" || !Number.isFinite(Date.parse(raw.fetched_at))) {
      throw new Error("The index needs a valid fetched_at timestamp.");
    }
    if (raw.videos.length > 100000) throw new Error("This index is too large (maximum 100,000 entries).");
    const unique = new Map();
    for (const video of raw.videos) {
      if (!video || typeof video.id !== "string" || !VIDEO_ID.test(video.id) || typeof video.title !== "string") {
        throw new Error("Every video must have an 11-character YouTube ID and a title.");
      }
      if (!unique.has(video.id)) unique.set(video.id, { id: video.id, title: video.title || video.id });
    }
    // Native string comparison matches Python's ordering; localeCompare does not.
    const videos = [...unique.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return {
      version: 1, source_url: url.href, source_type: type, source_title: title.trim(),
      channel_id: typeof raw.channel_id === "string" ? raw.channel_id : null,
      fetched_at: raw.fetched_at, videos,
    };
  }

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return false;
    const parsed = new Date(value + "T00:00:00Z");
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  function today() { return new Date().toISOString().slice(0, 10); }

  function shiftDate(value, amount) {
    if (!validDate(value)) throw new Error("Choose a valid date.");
    const parsed = new Date(value + "T00:00:00Z");
    parsed.setUTCDate(parsed.getUTCDate() + amount);
    const shifted = parsed.toISOString().slice(0, 10);
    if (!validDate(shifted)) throw new Error("That date is outside the supported range.");
    return shifted;
  }

  async function pick(index, day) {
    if (!validDate(day)) throw new Error("Choose a valid date in YYYY-MM-DD format.");
    if (!index.videos.length) throw new Error("This library has no videos.");
    if (!globalThis.crypto?.subtle) throw new Error("Open this page over HTTPS or as a local file in a modern browser.");
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(day)));
    // Taking the remainder byte by byte avoids JavaScript's 53-bit integer limit.
    let offset = 0;
    for (const byte of digest) offset = (offset * 256 + byte) % index.videos.length;
    return { ...index.videos[offset], index: offset, count: index.videos.length, date: day };
  }

  const api = { normalizeIndex, validDate, today, shiftDate, pick };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DailyVideo = api;
})(globalThis);
