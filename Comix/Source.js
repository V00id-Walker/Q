const COMIX_BASE = "https://comix.to";
const SAFE_RATINGS = "safe,suggestive";

function upstream(message, retryable) {
  return new Tamuro.ExtensionError("UPSTREAM_ERROR", message, retryable !== false);
}

async function request(url) {
  const response = await Tamuro.http.request({
    method: "GET",
    url,
    headers: { Accept: "text/html,application/json;q=0.9" }
  });
  if (response.status < 200 || response.status >= 300) {
    throw upstream(`Comix returned HTTP ${response.status}`, response.status >= 500);
  }
  return response;
}

function initialData(html) {
  const idAt = html.indexOf('id="initial-data"');
  if (idAt < 0) throw upstream("Comix page did not contain initial data", false);
  const start = html.indexOf(">", idAt) + 1;
  const end = html.indexOf("</script>", start);
  if (start < 1 || end < 0) throw upstream("Comix initial data was malformed", false);
  return JSON.parse(html.slice(start, end));
}

function queryValue(root, token) {
  const queries = root.queries || {};
  const key = Object.keys(queries).find(key => key.indexOf(`\"${token}\"`) >= 0);
  return key ? queries[key] : null;
}

function absolute(value) {
  return /^https:\/\//i.test(value || "") ? value : Tamuro.url.resolve(COMIX_BASE, value || "");
}

function basicManga(manga) {
  return {
    id: String(manga.hid),
    title: manga.title || "Untitled",
    url: absolute(manga.url || `/title/${manga.hid}`),
    cover: manga.poster ? { url: manga.poster.medium || manga.poster.large || manga.poster.small } : null,
    latestChapter: manga.latestChapter ? `Chapter ${manga.latestChapter}` : null
  };
}

const LIST_CAPTURE = `(function () {
  const bridge = window.__TAMURO_BRIDGE__;
  const submit = parsed => {
    try {
      const result = parsed && parsed.result ? parsed.result : parsed;
      if (result && Array.isArray(result.items)) {
        bridge.passPayload(JSON.stringify(result));
        return true;
      }
    } catch (_) {}
    return false;
  };
  try {
    const raw = document.querySelector('script#initial-data')?.textContent;
    const queries = raw && JSON.parse(raw).queries;
    if (queries) Object.values(queries).some(submit);
  } catch (_) {}
  if (JSON.parse.__tamuroComixList) return null;
  const original = JSON.parse;
  const proxy = new Proxy(original, { apply(target, self, args) {
    const parsed = Reflect.apply(target, self, args); submit(parsed); return parsed;
  }});
  proxy.__tamuroComixList = true;
  JSON.parse = proxy;
  return null;
})();`;

async function browserList(parameters) {
  const url = `${COMIX_BASE}/browse?${parameters.join("&")}`;
  const page = await request(url);
  const payload = await Tamuro.browser.capture({ url: page.url, html: page.body, script: LIST_CAPTURE, timeoutMs: 60000 });
  const result = JSON.parse(payload);
  const meta = result.meta || result.pagination || {};
  return {
    items: (result.items || []).map(basicManga),
    nextCursor: (meta.hasNext || Number(meta.page || 1) < Number(meta.lastPage || meta.last_page || 1))
      ? String(Number(meta.page || 1) + 1) : null,
    hasNextPage: Boolean(meta.hasNext || Number(meta.page || 1) < Number(meta.lastPage || meta.last_page || 1))
  };
}

function listParameters(cursor, limit, filters) {
  const params = [
    `page=${encodeURIComponent(cursor || "1")}`,
    `limit=${Math.max(1, Math.min(Number(limit) || 20, 50))}`,
    `content_rating=${encodeURIComponent(filters && filters.showAdultContent ? "safe,suggestive,erotica,pornographic" : SAFE_RATINGS)}`
  ];
  if (filters && filters.types) filters.types.forEach(value => params.push(`types%5B%5D=${encodeURIComponent(String(value).toLowerCase())}`));
  if (filters && filters.statuses) filters.statuses.forEach(value => params.push(`statuses%5B%5D=${encodeURIComponent(String(value).toLowerCase())}`));
  if (filters && filters.genreIds) filters.genreIds.forEach(value => params.push(`genres_in%5B%5D=${encodeURIComponent(value)}`));
  return params;
}

function names(values) {
  return Array.isArray(values) ? values.map(value => value.title || value.name || value).filter(Boolean) : [];
}

function status(value) {
  return ({ releasing: "ongoing", finished: "completed", on_hiatus: "hiatus", discontinued: "cancelled" })[value] || "unknown";
}

const CHAPTER_CAPTURE = `(function () {
  const bridge = window.__TAMURO_BRIDGE__;
  if (window.__tamuroChapterState) return null;
  const state = window.__tamuroChapterState = { pages:new Set(), items:[] };
  const capture = parsed => {
    try {
      const result = parsed && parsed.result;
      const items = result && result.items;
      if (!Array.isArray(items) || !items.length || items[0].number === undefined) return false;
      const meta = result.meta || result.pagination || {};
      const page = Number(meta.page || 1);
      if (state.pages.has(page)) return true;
      state.pages.add(page); state.items.push(...items);
      const last = Number(meta.lastPage || meta.last_page || page);
      if (!(meta.hasNext || page < last)) { bridge.passPayload(JSON.stringify(state.items)); return true; }
      bridge.resetTimer();
      let tries = 0;
      const timer = setInterval(() => {
        const buttons = [...document.querySelectorAll('.mchap-foot button')].filter(x => !x.disabled);
        const next = buttons.find(x => /next/i.test((x.ariaLabel||'')+' '+(x.title||'')+' '+(x.textContent||''))) ||
          buttons.find(x => Number(x.textContent.trim()) === page + 1);
        if (next) { clearInterval(timer); next.click(); }
        else if (++tries > 50) { clearInterval(timer); bridge.passPayload(JSON.stringify(state.items)); }
      }, 100);
      return true;
    } catch (_) { return false; }
  };
  const original = JSON.parse;
  JSON.parse = new Proxy(original, { apply(target,self,args) { const parsed=Reflect.apply(target,self,args); capture(parsed); return parsed; }});
  return null;
})();`;

const PAGE_CAPTURE = `(function () {
  const bridge = window.__TAMURO_BRIDGE__;
  const capture = parsed => {
    try { if (parsed?.result?.pages) { bridge.passPayload(JSON.stringify(parsed.result.pages)); return true; } } catch (_) {}
    return false;
  };
  const original = JSON.parse;
  JSON.parse = new Proxy(original, { apply(target,self,args) { const parsed=Reflect.apply(target,self,args); capture(parsed); return parsed; }});
  return null;
})();`;

Tamuro.registerSource({
  async getPopularManga({ cursor, limit }) {
    const params = listParameters(cursor, limit, null); params.push("order%5Bscore%5D=desc");
    return browserList(params);
  },

  async getLatestManga({ cursor, limit }) {
    const params = listParameters(cursor, limit, null); params.push("order%5Bchapter_updated_at%5D=desc");
    return browserList(params);
  },

  async searchManga({ query, cursor, limit, filters }) {
    const params = listParameters(cursor, limit, filters);
    if (query && query !== "*") params.push(`q=${encodeURIComponent(query)}`, "sort=relevance%3Adesc");
    return browserList(params);
  },

  async getMangaDetails({ mangaId }) {
    const page = await request(`${COMIX_BASE}/title/${encodeURIComponent(mangaId)}`);
    const manga = queryValue(initialData(page.body), "detail");
    if (!manga) throw upstream("Comix manga details were missing", false);
    return {
      ...basicManga(manga),
      alternativeTitles: manga.altTitles || manga.alt_titles || [],
      authors: names(manga.authors || manga.author), artists: names(manga.artists || manga.artist),
      genres: names(manga.genres || manga.genre).concat(names(manga.demographics || manga.demographic)),
      description: manga.synopsis || "", status: status(manga.status), type: manga.type || "manga",
      year: manga.year || null,
      nsfw: manga.contentRating === "erotica" || manga.contentRating === "pornographic"
    };
  },

  async getChapters({ mangaId }) {
    const page = await request(`${COMIX_BASE}/title/${encodeURIComponent(mangaId)}`);
    const payload = await Tamuro.browser.capture({ url: page.url, html: page.body, script: CHAPTER_CAPTURE, timeoutMs: 120000 });
    return JSON.parse(payload).map(chapter => {
      const path = chapter.url && chapter.url.indexOf("/title/") >= 0
        ? chapter.url.slice(chapter.url.indexOf("/title/") + 1)
        : `title/${mangaId}/${chapter.id}-chapter-${chapter.number}`;
      return {
        id: `${mangaId}|${chapter.id}|${encodeURIComponent(path)}`,
        name: `Chapter ${chapter.number}${chapter.name ? `: ${chapter.name}` : ""}`,
        url: `${COMIX_BASE}/${path}`, chapterNumber: Number(chapter.number), volumeNumber: null,
        scanlator: chapter.group ? chapter.group.name : (chapter.isOfficial ? "Official" : "Unknown"),
        language: "en", uploadedAt: null
      };
    });
  },

  async getPages({ chapterId }) {
    const parts = String(chapterId).split("|");
    if (parts.length < 3) throw new Tamuro.ExtensionError("INVALID_REQUEST", "Invalid Comix chapter ID", false);
    const url = `${COMIX_BASE}/${decodeURIComponent(parts.slice(2).join("|"))}`;
    const page = await request(url);
    const payload = await Tamuro.browser.capture({ url: page.url, html: page.body, script: PAGE_CAPTURE, timeoutMs: 60000 });
    const pages = JSON.parse(payload); const base = String(pages.baseUrl || "").replace(/\/$/, "");
    return (pages.items || []).map((item, index) => {
      let imageUrl = /^https:\/\//.test(item.url) ? item.url : `${base}/${String(item.url).replace(/^\//, "")}`;
      const version3 = item.s === 1 || imageUrl.indexOf("?v3") >= 0;
      if (version3 && imageUrl.indexOf("?v3") < 0 && imageUrl.indexOf("&v3") < 0) {
        imageUrl += imageUrl.indexOf("?") >= 0 ? "&v3" : "?v3";
      }
      return {
        index,
        image: {
          url: imageUrl,
          headers: version3 ? { Referer: `${COMIX_BASE}/` } : { Referer: `${COMIX_BASE}/`, Origin: COMIX_BASE }
        }
      };
    });
  },

  async getFilters() {
    return [
      { id:"showAdultContent", type:"toggle", name:"Show adult content", defaultValue:false },
      { id:"types", type:"multiSelect", name:"Type", options:["manga","manhwa","manhua"] },
      { id:"statuses", type:"multiSelect", name:"Status", options:["releasing","finished","on_hiatus","discontinued"] }
    ];
  }
});
