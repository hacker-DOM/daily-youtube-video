/* Shared by the static page and Node's built-in test runner. */
(function (root) {
  "use strict";
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const PLAYLIST_ID = /^(?:PL|UU|FL|OLAK5uy_)[A-Za-z0-9_-]+$/;

  function metadata(raw) {
    const result = {};
    for (const key of ["duration", "timestamp", "release_timestamp", "view_count", "like_count", "comment_count", "channel_follower_count"]) {
      if (typeof raw[key] === "number" && Number.isFinite(raw[key]) && raw[key] >= 0) result[key] = raw[key];
    }
    for (const key of ["description", "channel", "channel_id", "uploader", "language", "license", "availability", "live_status", "metadata_error"]) {
      if (typeof raw[key] === "string") result[key] = raw[key];
    }
    for (const key of ["upload_date", "release_date"]) {
      if (validDate(raw[key])) result[key] = raw[key];
    }
    for (const key of ["tags", "categories"]) {
      if (Array.isArray(raw[key])) result[key] = raw[key].filter(item => typeof item === "string");
    }
    if (typeof raw.metadata_fetched_at === "string" && Number.isFinite(Date.parse(raw.metadata_fetched_at))) result.metadata_fetched_at = raw.metadata_fetched_at;
    if (["complete", "listing"].includes(raw.metadata_status)) result.metadata_status = raw.metadata_status;
    if (raw.description_truncated === true) result.description_truncated = true;
    if (VIDEO_ID.test(raw.id) && raw.metadata_path === `data/metadata/videos/${raw.id}.json`) result.metadata_path = raw.metadata_path;
    return result;
  }

  function normalizePlaylists(raw) {
    if (!Array.isArray(raw) || raw.length > 10000) throw new Error("Invalid playlist metadata.");
    const ids = new Set();
    return raw.map(item => {
      if (!item || typeof item.id !== "string" || !PLAYLIST_ID.test(item.id) || ids.has(item.id) ||
          typeof item.title !== "string" || !Array.isArray(item.video_ids) || item.video_ids.length > 100000 ||
          !item.video_ids.every(id => typeof id === "string" && VIDEO_ID.test(id))) throw new Error("Invalid playlist metadata.");
      ids.add(item.id);
      return {id: item.id, title: item.title, video_ids: [...item.video_ids], video_count: item.video_ids.length,
        ...metadata(item),
        status: ["complete", "stale", "unavailable"].includes(item.status) ? item.status : "unavailable",
        fetched_at: typeof item.fetched_at === "string" && Number.isFinite(Date.parse(item.fetched_at)) ? item.fetched_at : null,
        modified_date: typeof item.modified_date === "string" ? item.modified_date : null,
        declared_count: Number.isSafeInteger(item.declared_count) && item.declared_count >= 0 ? item.declared_count : null,
        unavailable_count: Number.isSafeInteger(item.unavailable_count) && item.unavailable_count >= 0 ? item.unavailable_count : 0,
        hidden_count: Number.isSafeInteger(item.hidden_count) && item.hidden_count >= 0 ? item.hidden_count : 0,
      };
    });
  }

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
      if (!unique.has(video.id)) unique.set(video.id, { id: video.id, title: video.title || video.id, ...metadata(video) });
    }
    // Native string comparison matches Python's ordering; localeCompare does not.
    const videos = [...unique.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return {
      version: 1, source_url: url.href, source_type: type, source_title: title.trim(),
      channel_id: typeof raw.channel_id === "string" ? raw.channel_id : null,
      fetched_at: raw.fetched_at, videos,
      ...(raw.playlists !== undefined ? {playlists: normalizePlaylists(raw.playlists)} : {}),
      ...(["complete", "partial", "unavailable"].includes(raw.playlist_status) ? {playlist_status: raw.playlist_status} : {}),
      ...(["complete", "partial"].includes(raw.metadata_status) ? {metadata_status: raw.metadata_status} : {}),
      ...(raw.metadata_version === 1 ? {metadata_version: 1} : {}),
      ...(typeof raw.metadata_updated_at === "string" && Number.isFinite(Date.parse(raw.metadata_updated_at)) ? {metadata_updated_at: raw.metadata_updated_at} : {}),
      ...(raw.source_metadata && typeof raw.source_metadata === "object" ? {source_metadata: metadata(raw.source_metadata)} : {}),
    };
  }

  function validDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return false;
    const parsed = new Date(value + "T00:00:00Z");
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  function today(now = new Date()) {
    return [now.getFullYear().toString().padStart(4, "0"),
      String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  }

  function secondsUntilMidnight(now = new Date()) {
    const midnight = new Date(now.getTime());
    // Local calendar arithmetic accounts for 23- and 25-hour daylight saving days.
    midnight.setHours(24, 0, 0, 0);
    return Math.ceil((midnight - now) / 1000);
  }

  function shiftDate(value, amount) {
    if (!validDate(value)) throw new Error("Choose a valid date.");
    // UTC here is only for arithmetic on date-only values, independent of DST.
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

  const api = { normalizeIndex, validDate, today, secondsUntilMidnight, shiftDate, pick };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DailyVideo = api;
})(globalThis);
