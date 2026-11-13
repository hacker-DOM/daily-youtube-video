/* No framework, build step, server, or external JavaScript. */
(async function () {
  "use strict";
  const Core = window.DailyVideo;
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "daily-youtube-library-v1";
  const ACTIVE_KEY = "daily-youtube-active-v1";
  const example = Core.normalizeIndex(window.DAILY_EXAMPLE);
  let sources = [example];
  let activeUrl = example.source_url;
  let day = Core.today();
  let followsToday = true;
  let selected = null;
  let revision = 0;
  let toastTimer;
  let pendingRemoval;
  let persistentStorage = true;

  function notice(message) {
    $("notice-banner").textContent = message;
    $("notice-banner").hidden = false;
  }

  function showError(message) {
    $("error-banner").textContent = message;
    $("error-banner").hidden = false;
  }

  function toast(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").hidden = false;
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, 3000);
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sources));
      localStorage.setItem(ACTIVE_KEY, activeUrl || "");
      persistentStorage = true;
    } catch {
      persistentStorage = false;
      notice("Browser storage is unavailable or full. This session still works; export your libraries before closing the page.");
    }
  }

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) {
      const decoded = JSON.parse(saved);
      if (!Array.isArray(decoded)) throw new Error("Invalid saved library");
      sources = decoded.map(Core.normalizeIndex);
    }
    activeUrl = localStorage.getItem(ACTIVE_KEY) || sources[0]?.source_url;
  } catch {
    notice("Your saved library couldn't be loaded. Geography Now is available to get you started; you can reimport your other indexes.");
  }
  // Upgrade the example's metadata without changing a saved selection schedule.
  sources = sources.map(source => source.source_url === example.source_url && example.metadata_updated_at &&
    (!source.metadata_updated_at || Date.parse(example.metadata_updated_at) > Date.parse(source.metadata_updated_at)) &&
    source.videos.length === example.videos.length && source.videos.every((video, i) => video.id === example.videos[i].id)
    ? example : source);
  const requestedDate = new URLSearchParams(location.search).get("date");
  if (requestedDate && Core.validDate(requestedDate)) {
    day = requestedDate;
    followsToday = day === Core.today();
  }

  function activeSource() {
    return sources.find((source) => source.source_url === activeUrl) || sources[0];
  }

  function shortDate(value) {
    const dateOnly = Core.validDate(value);
    // Calendar labels retain the selected day; saved timestamps use local time.
    return new Intl.DateTimeFormat("en", {
      month: "short", day: "numeric", year: "numeric", ...(dateOnly ? { timeZone: "UTC" } : {}),
    }).format(new Date(dateOnly ? value + "T00:00:00Z" : value));
  }

  function renderLibrary() {
    $("library-list").replaceChildren();
    $("source-count").textContent = sources.length;
    for (const source of sources) {
      const button = document.createElement("button");
      button.className = "library-item";
      button.dataset.source = source.source_url;
      button.setAttribute("aria-current", String(source.source_url === activeSource()?.source_url));
      const avatar = document.createElement("span");
      avatar.className = "library-avatar";
      avatar.textContent = source.source_type === "playlist" ? "≡" : "◎";
      avatar.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.className = "library-text";
      const title = document.createElement("strong");
      title.textContent = source.source_title;
      const meta = document.createElement("span");
      meta.textContent = `${source.videos.length.toLocaleString()} videos · ${source.source_type}`;
      text.append(title, meta);
      button.append(avatar, text);
      $("library-list").append(button);
    }
  }

  async function render() {
    const currentRevision = ++revision;
    const source = activeSource();
    $("error-banner").hidden = true;
    $("pick-date").value = day;
    $("return-today").hidden = day === Core.today();
    $("pick-badge-label").textContent = day === Core.today() ? "TODAY'S PICK" : "YOUR PICK · " + shortDate(day).toUpperCase();
    $("day-label").textContent = day === Core.today() ? "YOUR DAILY DISCOVERY" : "A LITTLE TIME TRAVEL";
    $("empty-state").hidden = Boolean(source);
    for (const element of [$("video-card"), document.querySelector(".under-card"), document.querySelector(".library-details"), document.querySelector(".collection-footer")]) {
      element.hidden = !source;
    }
    renderLibrary();
    if (!source) { selected = null; $("insights").hidden = true; return; }
    activeUrl = source.source_url;
    $("video-card").setAttribute("aria-busy", "true");
    try {
      const choice = await Core.pick(source, day);
      if (currentRevision !== revision) return;
      selected = choice;
      window.DailyInsightsUI.render(source, choice);
      const watchUrl = `https://www.youtube.com/watch?v=${choice.id}`;
      $("watch-link").href = watchUrl;
      $("thumbnail-link").href = watchUrl;
      $("thumbnail-link").setAttribute("aria-label", `Watch ${choice.title} on YouTube`);
      $("video-title").textContent = choice.title;
      $("source-link").textContent = source.source_title;
      $("source-link").href = source.source_url;
      $("source-avatar").textContent = Array.from(source.source_title)[0].toUpperCase();
      $("source-type").textContent = source.source_type.toUpperCase();
      $("selection-position").textContent = `${choice.index + 1} of ${choice.count.toLocaleString()}`;
      $("video-count").textContent = choice.count.toLocaleString();
      $("collection-heading").textContent = source.source_type === "channel" ? "A whole channel to rediscover." : "Your playlist, one day at a time.";
      $("collection-description").textContent = source.source_type === "channel"
        ? "Every indexed video has a chance. Shorts and livestreams sit this one out."
        : "Every unique indexed video has a chance, including any Shorts in this playlist.";
      $("index-date").textContent = `Library saved ${shortDate(source.fetched_at)}`;
      $("video-thumbnail").hidden = true;
      $("video-thumbnail").alt = "";
      $("video-thumbnail").src = `https://i.ytimg.com/vi/${choice.id}/hqdefault.jpg`;
      document.title = `${source.source_title} · Daily`;
      updateClock();
    } catch (error) {
      if (currentRevision !== revision) return;
      selected = null;
      $("watch-link").removeAttribute("href");
      $("thumbnail-link").removeAttribute("href");
      $("video-title").textContent = "Couldn't choose a video.";
      showError(error.message);
    } finally {
      if (currentRevision === revision) $("video-card").setAttribute("aria-busy", "false");
    }
  }

  function setDay(value) {
    if (!Core.validDate(value)) { $("pick-date").value = day; showError("Choose a valid calendar date."); return; }
    day = value;
    followsToday = day === Core.today();
    render();
  }

  function updateClock() {
    const now = new Date();
    const today = Core.today(now);
    if (followsToday && day !== today) { day = today; render(); return; }
    if (day !== today) { $("next-pick").textContent = "Exploring " + shortDate(day); return; }
    const seconds = Core.secondsUntilMidnight(now);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    $("next-pick").textContent = `Next pick in ${hours}h ${String(minutes).padStart(2, "0")}m · local time`;
  }

  function openImport() {
    $("suggestion-setup").hidden = true;
    $("import-error").hidden = true;
    $("index-file").value = "";
    $("import-dialog").showModal();
  }

  window.addEventListener("daily:suggestion", (event) => {
    const suggestion = event.detail;
    openImport();
    $("suggestion-setup").hidden = false;
    $("setup-title").textContent = "Add " + suggestion.name;
    $("setup-description").textContent = suggestion.url
      ? "Create this source's video index once to get daily picks."
      : "Find this source on YouTube, then paste its channel or playlist URL here.";
    $("suggestion-url").value = suggestion.url || "";
    updateSuggestionCommand();
    if (!suggestion.url) $("suggestion-url").focus();
  });

  function updateSuggestionCommand() {
    const value = $("suggestion-url").value.trim();
    $("suggestion-url-error").hidden = true;
    try {
      $("suggestion-command").textContent = value ? window.DailySuggestions.indexCommand(value) : "Paste the source URL above to create an index command.";
      $("copy-index-command").disabled = !value;
    } catch (error) {
      $("suggestion-command").textContent = "";
      $("copy-index-command").disabled = true;
      $("suggestion-url-error").textContent = error.message;
      $("suggestion-url-error").hidden = false;
    }
  }

  $("suggestion-url").addEventListener("input", updateSuggestionCommand);
  $("copy-index-command").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("suggestion-command").textContent);
      toast("Index command copied");
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents($("suggestion-command"));
      selection.removeAllRanges();
      selection.addRange(range);
      toast("Select and copy the highlighted command.");
    }
  });

  async function saveIndex(index) {
    const existing = sources.findIndex((source) => source.source_url === index.source_url || (
      source.source_type === "channel" && index.source_type === "channel" && source.channel_id && source.channel_id === index.channel_id
    ));
    if (existing >= 0) sources[existing] = index;
    else sources.push(index);
    activeUrl = index.source_url;
    persist();
    $("import-dialog").close();
    await render();
    toast(`${index.source_title} ${existing >= 0 ? "updated" : "added"}${persistentStorage ? "" : " for this session"}`);
  }

  window.addEventListener("daily:bundled-index", async event => {
    try { await saveIndex(Core.normalizeIndex(event.detail)); }
    catch (error) { showError(error.message); }
  });

  async function importFile(file) {
    if (!file) return;
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error("Choose a JSON index smaller than 50 MB.");
      let raw;
      try { raw = JSON.parse(await file.text()); }
      catch { throw new Error("That file isn't valid JSON. Export a video index and try again."); }
      const index = Core.normalizeIndex(raw);
      await saveIndex(index);
    } catch (error) {
      $("import-error").textContent = error.message;
      $("import-error").hidden = false;
    } finally { $("index-file").value = ""; }
  }

  $("library-list").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-source]");
    if (!button) return;
    activeUrl = button.dataset.source;
    persist();
    render();
  });
  $("pick-date").addEventListener("change", (event) => setDay(event.target.value));
  for (const [id, amount] of [["previous-day", -1], ["next-day", 1]]) {
    $(id).addEventListener("click", () => {
      try { setDay(Core.shiftDate(day, amount)); } catch (error) { showError(error.message); }
    });
  }
  $("return-today").addEventListener("click", () => setDay(Core.today()));
  $("video-thumbnail").addEventListener("load", () => { $("video-thumbnail").hidden = false; });
  $("video-thumbnail").addEventListener("error", () => { $("video-thumbnail").hidden = true; });
  $("about-button").addEventListener("click", () => $("about-dialog").showModal());
  for (const id of ["add-source", "empty-add", "update-index"]) $(id).addEventListener("click", openImport);
  for (const button of document.querySelectorAll("[data-close]")) {
    button.addEventListener("click", () => $(button.dataset.close).close());
  }
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.addEventListener("click", (event) => {
      const bounds = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
    });
  }
  $("index-file").addEventListener("change", (event) => importFile(event.target.files[0]));
  for (const name of ["dragover", "dragenter"]) {
    $("drop-zone").addEventListener(name, (event) => { event.preventDefault(); $("drop-zone").classList.add("dragging"); });
  }
  for (const name of ["dragleave", "drop"]) {
    $("drop-zone").addEventListener(name, (event) => { event.preventDefault(); $("drop-zone").classList.remove("dragging"); });
  }
  $("drop-zone").addEventListener("drop", (event) => importFile(event.dataTransfer.files[0]));
  $("copy-video").addEventListener("click", async () => {
    if (!selected) return;
    const link = `https://www.youtube.com/watch?v=${selected.id}`;
    try {
      await navigator.clipboard.writeText(link);
      toast("Video link copied");
    } catch {
      const field = document.createElement("textarea");
      field.value = link;
      field.style.cssText = "position:fixed;opacity:0;top:0";
      document.body.append(field);
      field.select();
      const success = document.execCommand("copy");
      field.remove();
      toast(success ? "Video link copied" : "Copy the link from the Watch on YouTube button.");
    }
  });
  $("export-index").addEventListener("click", () => {
    const source = activeSource();
    if (!source) return;
    const blob = new Blob([JSON.stringify(source, null, 2) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = (source.source_title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "library") + ".json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $("remove-index").addEventListener("click", () => {
    const source = activeSource();
    if (!source) return;
    pendingRemoval = source.source_url;
    $("remove-description").textContent = `${source.source_title} will be removed from this browser. Export it first if you want to keep a copy.`;
    $("remove-dialog").showModal();
  });
  $("confirm-remove").addEventListener("click", () => {
    sources = sources.filter((source) => source.source_url !== pendingRemoval);
    activeUrl = sources[0]?.source_url;
    persist();
    $("remove-dialog").close();
    render();
    toast("Library removed");
  });
  $("restore-example").addEventListener("click", () => { sources.push(example); activeUrl = example.source_url; persist(); render(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) updateClock(); });
  setInterval(updateClock, 15000);
  await render();
})();
