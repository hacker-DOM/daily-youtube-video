/* Pure chart calculations shared with tests. Missing statistics stay missing. */
(function (root) {
  "use strict";
  const metrics = {videos: "Videos", view_count: "Views", like_count: "Likes"};
  const known = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const dayOf = video => video.upload_date || video.release_date;
  function series(index, {metric = "videos", interval = "year", from = "0001-01-01", to = "9999-12-31"} = {}) {
    if (!(metric in metrics) || !["month", "year"].includes(interval)) throw new Error("Unknown chart option");
    const length = interval === "year" ? 4 : 7;
    const eligible = index.videos.filter(video => dayOf(video) && dayOf(video) >= from && dayOf(video) <= to);
    const buckets = new Map();
    for (const video of eligible) {
      const key = dayOf(video).slice(0, length);
      if (!buckets.has(key)) buckets.set(key, {key, total: 0, known: 0, missing: 0, videos: 0});
      const bucket = buckets.get(key);
      bucket.videos++;
      if (metric === "videos" || known(video[metric])) { bucket.total += metric === "videos" ? 1 : video[metric]; bucket.known++; }
      else bucket.missing++;
    }
    const keys = [...buckets.keys()].sort();
    const rows = [];
    if (keys.length) {
      let [year, month = 1] = keys[0].split("-").map(Number);
      while (true) {
        const key = String(year).padStart(4, "0") + (interval === "month" ? "-" + String(month).padStart(2, "0") : "");
        if (key > keys.at(-1)) break;
        const row = buckets.get(key) || {key, total: 0, known: 0, missing: 0, videos: 0};
        // An empty publication period is a real zero; videos with hidden counts are unknown.
        rows.push({...row, value: row.known || !row.videos ? row.total : null});
        if (interval === "year" || ++month > 12) { year++; month = 1; }
      }
    }
    return {rows, dated: index.videos.filter(v => dayOf(v)).length, total: index.videos.length,
      included: eligible.length, known: rows.reduce((n, row) => n + row.known, 0),
      missing: rows.reduce((n, row) => n + row.missing, 0)};
  }
  function summary(index) {
    const dates = index.videos.map(dayOf).filter(Boolean).sort();
    const result = {first: dates[0], last: dates.at(-1), dated: dates.length, total: index.videos.length};
    for (const key of ["view_count", "like_count"]) {
      const values = index.videos.map(video => video[key]).filter(known);
      result[key] = {total: values.reduce((a, b) => a + b, 0), known: values.length};
    }
    return result;
  }
  function memberships(index, videoId) {
    return (index.playlists || []).filter(playlist => playlist.video_ids.includes(videoId));
  }
  function periodLabel(key) {
    if (key.length === 4) return key;
    return new Intl.DateTimeFormat("en", {month: "short", year: "numeric", timeZone: "UTC"}).format(new Date(key + "-01T00:00:00Z"));
  }
  const api = {metrics, known, dayOf, series, summary, memberships, periodLabel};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DailyInsights = api;
})(globalThis);
