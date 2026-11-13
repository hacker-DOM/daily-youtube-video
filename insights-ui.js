(function (root) {
  "use strict";
  const $ = id => document.getElementById(id);
  const Insights = root.DailyInsights;
  const count = value => value.toLocaleString("en");
  const compact = value => new Intl.NumberFormat("en", {notation: "compact", maximumFractionDigits: 1}).format(value);
  const dateLabel = value => new Intl.DateTimeFormat("en", {month: "short", day: "numeric", year: "numeric", timeZone: "UTC"}).format(new Date(value + "T00:00:00Z"));
  const captureLabel = value => new Intl.DateTimeFormat("en", {month: "short", day: "numeric", year: "numeric"}).format(new Date(value));
  let source, choice, metric = "videos", pageSize = 8;
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  function link(text, url, className) {
    const node = element("a", text, className);
    node.href = url; node.target = "_blank"; node.rel = "noopener noreferrer";
    return node;
  }
  const playlistURL = id => `https://www.youtube.com/playlist?list=${id}`;
  function duration(value) {
    const seconds = Math.floor(value);
    return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
  function videoDetails() {
    const facts = [];
    if (Insights.dayOf(choice)) facts.push("Published " + dateLabel(Insights.dayOf(choice)));
    if (Insights.known(choice.duration)) facts.push(duration(choice.duration));
    for (const [key, label] of [["view_count", "views"], ["like_count", "likes"], ["comment_count", "comments"]]) {
      if (Insights.known(choice[key])) facts.push(count(choice[key]) + " " + label);
    }
    $("video-facts").replaceChildren(...facts.map(text => element("span", text)));
    if (choice.metadata_fetched_at) $("video-facts").append(element("small", `Stats captured ${captureLabel(choice.metadata_fetched_at)}${choice.metadata_error ? " · refresh incomplete" : ""}`));
    $("video-description-panel").hidden = !choice.description && !choice.tags?.length;
    $("video-description").textContent = (choice.description || "") + (choice.description_truncated ? "…" : "");
    $("video-tags").replaceChildren(...(choice.tags || []).map(tag => element("span", tag)));
    const isBundled = source.source_url === root.DAILY_EXAMPLE?.source_url || Object.values(root.DAILY_INDEX_MANIFEST?.items || {}).some(item => item.status === "ready" && item.source_url === source.source_url);
    const download = $("video-metadata-download");
    download.hidden = !choice.metadata_path || !isBundled;
    download.onclick = null;
    download.textContent = "Full metadata JSON ↓";
    if (choice.metadata_path && isBundled) {
      download.href = choice.metadata_path;
      if (root.DAILY_SITE_CONFIG?.metadata_base) {
        const videoId = choice.id;
        download.href = `${root.DAILY_SITE_CONFIG.metadata_base}/videos/${root.DailyData.shardKey(videoId)}.json.gz`;
        let busy = false;
        download.onclick = async event => {
          event.preventDefault();
          if (busy) return;
          busy = true;
          download.textContent = "Downloading metadata…";
          try {
            const archive = await root.DailyData.metadata(videoId);
            const blob = new Blob([JSON.stringify(archive, null, 2) + "\n"], {type: "application/json"});
            const url = URL.createObjectURL(blob);
            const anchor = element("a");
            anchor.href = url; anchor.download = `${videoId}.json`;
            document.body.append(anchor); anchor.click(); anchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            download.textContent = "Full metadata JSON ↓";
          } catch (error) {
            download.textContent = "Download failed — try again";
            download.title = error.message;
          } finally { busy = false; }
        };
      }
    }
    const memberships = Insights.memberships(source, choice.id);
    $("video-playlists").replaceChildren();
    if (memberships.length) {
      $("video-playlists").append(element("span", "In these playlists", "membership-label"));
      for (const playlist of memberships) {
        $("video-playlists").append(link(playlist.title + (playlist.status === "stale" ? " · saved earlier" : ""),
          `https://www.youtube.com/watch?v=${choice.id}&list=${playlist.id}`, "playlist-chip"));
      }
    } else {
      $("video-playlists").append(element("span", source.playlist_status === "complete"
        ? "Not found in this source’s indexed playlists."
        : "Playlist membership is not fully indexed yet.", "membership-empty"));
    }
  }
  function stats() {
    const data = Insights.summary(source);
    const cards = [
      [data.first ? `${data.first.slice(0, 4)}–${data.last.slice(0, 4)}` : "—", "Years of discovery", `${count(data.dated)} of ${count(data.total)} videos dated`],
      [data.view_count.known ? compact(data.view_count.total) : "—", "Captured views", `${count(data.view_count.known)} of ${count(data.total)} videos with counts`],
      [data.like_count.known ? compact(data.like_count.total) : "—", "Captured likes", `${count(data.like_count.known)} of ${count(data.total)} videos with counts`],
    ];
    $("insight-stats").replaceChildren(...cards.map(([value, label, note]) => {
      const card = element("div", undefined, "insight-stat");
      card.append(element("span", label), element("strong", value), element("small", note));
      return card;
    }));
    $("metadata-captured").textContent = source.metadata_updated_at
      ? `${source.metadata_status === "partial" ? "Partial capture" : "Captured"} · ${captureLabel(source.metadata_updated_at)}`
      : "Metadata not fully indexed";
    $("insights-heading").textContent = source.source_type === "playlist" ? "A playlist, through time." : "A channel, through time.";
  }
  function drawChart() {
    const interval = $("chart-interval").value;
    const range = $("chart-range").value;
    const today = root.DailyVideo.today();
    let from = "0001-01-01";
    if (range === "5y") from = `${Number(today.slice(0, 4)) - 4}-01-01`;
    if (range === "12m") {
      const start = new Date(today.slice(0, 7) + "-01T00:00:00Z");
      start.setUTCMonth(start.getUTCMonth() - 11); from = start.toISOString().slice(0, 10);
    }
    const data = Insights.series(source, {metric, interval, from, to: range === "all" ? "9999-12-31" : today});
    $("chart-heading").textContent = metric === "videos" ? "The publishing rhythm" : `${Insights.metrics[metric]} by publication ${interval}`;
    $("chart-explanation").textContent = metric === "videos"
      ? `Indexed videos published each ${interval}. Tap a bar to see the count.`
      : `Captured lifetime ${Insights.metrics[metric].toLowerCase()} on videos published each ${interval}. These are not ${Insights.metrics[metric].toLowerCase()} earned during that period.`;
    $("chart-coverage").textContent = `${count(data.dated)} of ${count(data.total)} videos have a publication date. ${count(data.total - data.dated)} undated videos excluded. ` +
      (metric === "videos" ? "Dates are those reported by YouTube; archive dates use UTC." : `${count(data.known)} of ${count(data.included)} videos in this period have ${Insights.metrics[metric].toLowerCase()} data. Missing counts are not treated as zero.`);
    $("chart-empty").hidden = data.rows.length > 0;
    $("chart-empty").textContent = data.dated ? "No dated videos in this period. Try All time." : "This library doesn’t have publication dates yet. Add an enriched index to reveal its history.";
    $("chart-scroll").hidden = !data.rows.length;
    $("chart-tooltip").hidden = !data.rows.length;
    $("chart-table-panel").hidden = !data.rows.length;
    $("chart-tooltip").textContent = "Select a bar to explore a period. Use arrow keys to move between bars.";
    const svg = $("upload-chart"); svg.replaceChildren();
    const width = Math.max(680, data.rows.length * 24 + 80), height = 248;
    const left = 55, top = 20, bottom = 202, right = width - 16;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.style.minWidth = Math.min(width, 5000) + "px";
    const makeSVG = (tag, attrs, text) => {
      const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const largest = Math.max(1, ...data.rows.map(row => row.value || 0));
    const magnitude = 10 ** Math.floor(Math.log10(largest / 4));
    const tick = Math.max(1, [1, 2, 5, 10].find(n => n * magnitude >= largest / 4) * magnitude);
    const max = Math.ceil(largest / tick) * tick;
    for (let value = 0; value <= max; value += tick) {
      const y = bottom - value / max * (bottom - top);
      svg.append(makeSVG("line", {x1: left, x2: right, y1: y, y2: y, class: "chart-gridline"}));
      svg.append(makeSVG("text", {x: left - 9, y: y + 4, "text-anchor": "end", class: "chart-axis"}, compact(value)));
    }
    const step = (right - left) / Math.max(1, data.rows.length);
    const groups = [];
    const describe = row => `${Insights.periodLabel(row.key)} · ${row.value === null ? "Unknown" : count(row.value)} ${Insights.metrics[metric].toLowerCase()} · ${row.known}/${row.videos} videos with data${row.missing ? ` · ${row.missing} missing` : ""}`;
    data.rows.forEach((row, i) => {
      const x = left + i * step, h = row.value === null ? 0 : row.value / max * (bottom - top);
      const group = makeSVG("g", {tabindex: i === 0 ? 0 : -1, role: "button", "aria-label": describe(row), class: "chart-bar"});
      group.append(makeSVG("rect", {x: x + 2, y: top, width: Math.max(2, step - 4), height: bottom - top, fill: "transparent"}));
      group.append(makeSVG("rect", {x: x + 3, y: bottom - Math.max(2, h), width: Math.max(2, step - 6), height: Math.max(2, h), rx: 3, class: row.value === null ? "bar-unknown" : "bar-value"}));
      group.append(makeSVG("title", {}, describe(row)));
      const select = () => {
        groups.forEach(other => {other.classList.remove("is-selected"); other.setAttribute("tabindex", "-1");});
        group.classList.add("is-selected"); group.setAttribute("tabindex", "0");
        $("chart-tooltip").textContent = describe(row);
      };
      group.addEventListener("pointerenter", select);
      group.addEventListener("click", select);
      group.addEventListener("focus", select);
      group.addEventListener("keydown", event => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? groups.length - 1 : Math.max(0, Math.min(groups.length - 1, i + (event.key === "ArrowRight" ? 1 : -1)));
          groups[next].focus();
        } else if (["Enter", " "].includes(event.key)) { event.preventDefault(); select(); }
      });
      groups.push(group); svg.append(group);
      if (i % Math.max(1, Math.ceil(65 / step)) === 0) svg.append(makeSVG("text", {x: x + step / 2, y: bottom + 25, "text-anchor": "middle", class: "chart-axis"}, row.key));
    });
    $("chart-table-caption").textContent = `${Insights.metrics[metric]} grouped by publication ${interval}`;
    $("chart-table-body").replaceChildren(...data.rows.map(row => {
      const tr = element("tr"); tr.append(element("th", Insights.periodLabel(row.key)), element("td", row.value === null ? "Unknown" : count(row.value)), element("td", `${row.known} / ${row.videos}`)); return tr;
    }));
  }
  function playlists() {
    const items = source.playlists || [];
    const term = $("playlist-search").value.trim().toLocaleLowerCase();
    const filtered = items.filter(item => (item.title + " " + (item.description || "")).toLocaleLowerCase().includes(term));
    const indexed = new Set(source.videos.map(video => video.id));
    $("playlists-coverage").textContent = source.playlist_status === "complete"
      ? `${count(items.length)} public ${source.source_type === "channel" ? "channel playlists" : "playlist"} indexed. Membership covers visible videos in these lists only.`
      : `${count(items.length)} saved playlists. Discovery or membership is incomplete; some playlists may be missing.`;
    $("playlist-grid").replaceChildren();
    if (!filtered.length) $("playlist-grid").append(element("p", items.length ? "No matching playlists." : source.playlist_status === "complete" ? "No public playlists were found for this channel." : "Playlist details will appear when this library is enriched.", "playlist-empty"));
    for (const item of filtered.slice(0, pageSize)) {
      const card = element("article", undefined, "playlist-card");
      const included = new Set(item.video_ids.filter(id => indexed.has(id))).size;
      const top = element("div", undefined, "playlist-card-top");
      top.append(element("span", "≡", "playlist-glyph"), element("span", item.status === "complete" ? `${count(item.video_ids.length)} entries${item.hidden_count ? ` · ${count(item.hidden_count)} hidden` : ""}` : item.status === "stale" ? "Saved earlier" : "Unavailable", "playlist-card-count"));
      const heading = element("h4"); heading.append(link(item.title, playlistURL(item.id)));
      card.append(top, heading, element("p", item.description || "No description provided.", "playlist-description"), element("small", `${count(included)} videos in this library${item.channel ? " · " + item.channel : ""}`));
      if (item.fetched_at) card.append(element("small", "Captured " + captureLabel(item.fetched_at)));
      card.append(link("Open playlist ↗", playlistURL(item.id), "text-button"));
      $("playlist-grid").append(card);
    }
    $("playlists-more").hidden = filtered.length <= pageSize;
  }
  root.DailyInsightsUI = {render(index, video) {
    if (source?.source_url !== index.source_url) { $("playlist-search").value = ""; pageSize = 8; }
    source = index; choice = video;
    $("insights").hidden = false;
    videoDetails(); stats(); drawChart(); playlists();
  }};
  document.addEventListener("DOMContentLoaded", () => {
    for (const button of document.querySelectorAll("[data-metric]")) button.addEventListener("click", () => {
      metric = button.dataset.metric;
      for (const other of document.querySelectorAll("[data-metric]")) other.setAttribute("aria-pressed", String(other === button));
      if (source) drawChart();
    });
    for (const id of ["chart-interval", "chart-range"]) $(id).addEventListener("change", () => {
      if (id === "chart-range" && $(id).value === "12m") $("chart-interval").value = "month";
      if (source) drawChart();
    });
    $("playlist-search").addEventListener("input", () => { pageSize = 8; if (source) playlists(); });
    $("playlists-more").addEventListener("click", () => { pageSize += 8; if (source) playlists(); });
  });
})(globalThis);
