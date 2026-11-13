/* Load only the selected, prebuilt library. Also works when opening index.html. */
(function (root) {
  "use strict";
  function createLoader(manifest, read, normalize) {
    const pending = new Map();
    function entry(id) {
      if (!/^[a-f0-9]{16}$/.test(id)) return null;
      const value = manifest?.version === 1 ? manifest.items?.[id] : null;
      const validPath = value?.path === `data/indexes/${id}.js` || value?.path === `data/indexes/${id}.json.gz`;
      return value?.status === "ready" && validPath ? value : null;
    }
    function load(id) {
      const item = entry(id);
      if (!item) return Promise.reject(new Error("This source has not been bundled yet."));
      if (!pending.has(id)) {
        const request = Promise.resolve().then(() => read(id, item.path)).then(raw => {
          const index = normalize(raw);
          if (index.source_url !== item.source_url || index.videos.length !== item.count) {
            throw new Error("This library does not match the site catalog. Reload the page and try again.");
          }
          return index;
        }).catch(error => { pending.delete(id); throw error; });
        pending.set(id, request);
      }
      // Callers must not mutate the shared cached snapshot.
      return pending.get(id).then(index => JSON.parse(JSON.stringify(index)));
    }
    return { entry, load };
  }
  if (typeof module !== "undefined" && module.exports) { module.exports = { createLoader }; return; }
  root.DAILY_INDEXES = root.DAILY_INDEXES || {};
  root.DailyBundles = createLoader(root.DAILY_INDEX_MANIFEST, (id, path) => {
    if (root.DAILY_INDEXES[id]) return Promise.resolve(root.DAILY_INDEXES[id]);
    if (path.endsWith(".json.gz")) return root.DailyData.readJSON(path);
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const timer = setTimeout(() => finish(new Error("Loading this library timed out. Check your connection and try again.")), 20000);
      function finish(error) {
        clearTimeout(timer);
        script.onload = script.onerror = null;
        script.remove();
        if (error) reject(error);
        else if (!root.DAILY_INDEXES[id]) reject(new Error("This library file is empty. Try reloading the site."));
        else resolve(root.DAILY_INDEXES[id]);
      }
      script.src = path;
      script.onload = () => finish();
      script.onerror = () => finish(new Error("Couldn't load this library. Check your connection and try again."));
      document.head.append(script);
    });
  }, root.DailyVideo.normalizeIndex);
})(globalThis);
