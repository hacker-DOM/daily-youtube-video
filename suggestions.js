(function (root) {
  "use strict";

  function searchable(value) {
    return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }

  function filter(items, { query = "", category = "", addedOnly = false } = {}) {
    const terms = searchable(query.trim()).split(/\s+/).filter(Boolean);
    return items.filter(item => {
      if (category && !item.categories.includes(category)) return false;
      if (addedOnly && !item.added_since_github) return false;
      const text = searchable([item.name, ...item.aliases, ...item.categories, ...item.notes].join(" "));
      return terms.every(term => text.includes(term));
    });
  }

  function indexCommand(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error("Paste a complete YouTube channel or playlist URL."); }
    if (url.protocol !== "https:" || !["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(url.hostname) || url.username || url.password || url.port) {
      throw new Error("Use an HTTPS YouTube channel or playlist URL.");
    }
    if (url.searchParams.has("list")) {
      const id = url.searchParams.get("list");
      if (!/^(PL|UU|FL|OLAK5uy_)[A-Za-z0-9_-]+$/.test(id) || url.searchParams.getAll("list").length !== 1) throw new Error("Use a saved playlist, not a dynamic Mix.");
      url = new URL("https://www.youtube.com/playlist");
      url.searchParams.set("list", id);
    } else {
      if (url.hostname === "youtu.be") throw new Error("Use a channel or playlist URL, not an individual video.");
      const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
      const reserved = ["watch", "shorts", "playlist", "results", "feed", "embed", "live", "redirect"];
      const baseLength = ["c", "user", "channel"].includes(parts[0]) ? 2 : 1;
      if (!parts[0] || reserved.includes(parts[0]) || parts[0] === "@" || (baseLength === 2 && !parts[1]) ||
        (parts[0] === "channel" && !/^UC[A-Za-z0-9_-]{22}$/.test(parts[1])) ||
        parts.length > baseLength + 1 ||
        (parts.length > baseLength && !["videos", "playlists", "featured", "shorts", "streams", "about", "community"].includes(parts.at(-1)))) {
        throw new Error("Use a YouTube channel or playlist URL.");
      }
      url = new URL("https://www.youtube.com/" + parts.slice(0, baseLength).join("/"));
    }
    // Quote the entire URL for POSIX shells, including any apostrophes in old usernames.
    const quoted = "'" + url.href.replaceAll("'", "'\"'\"'") + "'";
    return `uv run tools/index_source.py ${quoted} --output my-library.json`;
  }

  const api = { filter, indexCommand };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }
  root.DailySuggestions = api;
  const catalog = root.DAILY_SUGGESTIONS;
  const $ = id => document.getElementById(id);
  const pageSize = 24;
  let page = 0;
  $("suggestion-count").textContent = catalog.items.length;
  for (const category of catalog.categories) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    $("suggestion-category").append(option);
  }

  function render() {
    const items = filter(catalog.items, { query: $("suggestion-search").value, category: $("suggestion-category").value, addedOnly: $("suggestion-new-only").checked });
    const pages = Math.max(1, Math.ceil(items.length / pageSize));
    page = Math.min(page, pages - 1);
    const start = page * pageSize;
    $("suggestion-results-count").textContent = items.length ? `${start + 1}–${Math.min(start + pageSize, items.length)} of ${items.length} suggestions` : "0 suggestions";
    $("suggestion-no-results").hidden = Boolean(items.length);
    $("suggestion-page").textContent = `Page ${page + 1} of ${pages}`;
    $("suggestion-previous").disabled = page === 0;
    $("suggestion-next").disabled = page >= pages - 1;
    $("suggestion-results").replaceChildren();
    for (const item of items.slice(start, start + pageSize)) {
      const card = document.createElement("article");
      card.className = "suggestion-card";
      const heading = document.createElement("h3");
      heading.textContent = item.name;
      const tag = document.createElement("p");
      tag.className = "suggestion-tag";
      tag.textContent = [item.kind === "playlist" ? "Playlist" : "Channel", item.added_since_github ? "Added since GitHub" : null].filter(Boolean).join(" · ");
      const category = document.createElement("p");
      category.className = "suggestion-categories";
      category.textContent = item.categories.join(" · ");
      const description = document.createElement("p");
      description.className = "suggestion-note";
      description.textContent = [...item.notes, ...item.aliases.map(alias => `Also listed as ${alias}`)].join(" · ") || "Explore this " + item.kind + ".";
      const actions = document.createElement("div");
      actions.className = "suggestion-actions";
      const visit = document.createElement("a");
      visit.className = "text-button";
      visit.href = item.url || item.search_url;
      visit.target = "_blank";
      visit.rel = "noopener noreferrer";
      visit.textContent = item.url ? "YouTube ↗" : "Find on YouTube ↗";
      const use = document.createElement("button");
      use.className = "secondary-button";
      use.textContent = "Use " + item.kind + " →";
      use.addEventListener("click", () => {
        $("suggestions-dialog").close();
        root.dispatchEvent(new CustomEvent("daily:suggestion", { detail: item }));
      });
      actions.append(visit, use);
      card.append(tag, heading, category, description, actions);
      $("suggestion-results").append(card);
    }
  }

  $("browse-suggestions").addEventListener("click", () => { render(); $("suggestions-dialog").showModal(); $("suggestion-search").focus(); });
  for (const id of ["suggestion-search", "suggestion-category", "suggestion-new-only"]) {
    $(id).addEventListener(id === "suggestion-search" ? "input" : "change", () => { page = 0; render(); });
  }
  for (const [id, delta] of [["suggestion-previous", -1], ["suggestion-next", 1]]) {
    $(id).addEventListener("click", () => { page += delta; render(); $("suggestion-results-count").scrollIntoView({ block: "nearest" }); });
  }
})(globalThis);
