/* Atsumaru (atsu.moe) source for Tamuro.
 *
 * Required manifest hosts: atsu.moe
 */
const ATSU_BASE = "https://atsu.moe";
const ATSU_SEARCH = `${ATSU_BASE}/collections/manga/documents/search`;

function extensionError(message, retryable) {
  return new Tamuro.ExtensionError("UPSTREAM_ERROR", message, retryable !== false);
}

async function get(url) {
  const response = await Tamuro.http.request({
    method: "GET",
    url,
    headers: {
      Accept: "application/json, text/html;q=0.9",
      "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36"
    }
  });
  if (response.status < 200 || response.status >= 300) {
    throw extensionError(`Atsumaru returned HTTP ${response.status}`, response.status >= 500);
  }
  return response.body;
}

async function getJson(url) {
  const body = await get(url);
  try {
    return JSON.parse(body);
  } catch (_) {
    throw extensionError("Atsumaru returned invalid JSON", false);
  }
}

function assetUrl(path) {
  if (!path) return null;
  if (/^https:\/\//i.test(path)) return path;
  if (path.indexOf("/static/") === 0) return ATSU_BASE + path;
  return `${ATSU_BASE}/static/${String(path).replace(/^\/+/, "")}`;
}

function coverFrom(value) {
  if (!value) return null;
  if (typeof value === "string") return { url: assetUrl(value) };
  const path = value.mediumImage || value.largeImage || value.image || value.smallImage;
  return path ? { url: assetUrl(path) } : null;
}

function pageNumber(cursor) {
  const parsed = Number.parseInt(cursor || "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeStatus(status) {
  const value = String(status || "unknown").toLowerCase();
  if (value.indexOf("ongoing") >= 0 || value.indexOf("publishing") >= 0) return "ongoing";
  if (value.indexOf("complete") >= 0 || value.indexOf("finished") >= 0) return "completed";
  if (value.indexOf("hiatus") >= 0) return "hiatus";
  if (value.indexOf("cancel") >= 0 || value.indexOf("discontinued") >= 0) return "cancelled";
  return "unknown";
}

function normalizeType(type) {
  const value = String(type || "manga").toLowerCase();
  if (value.indexOf("manhwa") >= 0) return "manhwa";
  if (value.indexOf("manhua") >= 0) return "manhua";
  if (value.indexOf("novel") >= 0) return "novel";
  if (value.indexOf("comic") >= 0) return "comic";
  return "manga";
}

function searchItem(document) {
  return {
    id: String(document.id),
    title: document.title || "Untitled",
    url: `${ATSU_BASE}/manga/${encodeURIComponent(document.id)}`,
    cover: coverFrom(document.posterMedium || document.poster || document.posterSmall),
    latestChapter: document.chapterCount ? `Chapter ${document.chapterCount}` : null
  };
}

function filterExpression(filters) {
  const expressions = ["hidden:!=true"];
  if (!filters || filters.showAdultContent !== true) expressions.push("isAdult:=false");
  if (filters && filters.types && filters.types.length) {
    expressions.push(`type:=[${filters.types.map(value => `\`${String(value)}\``).join(",")}]`);
  }
  if (filters && filters.statuses && filters.statuses.length) {
    expressions.push(`status:=[${filters.statuses.map(value => `\`${String(value)}\``).join(",")}]`);
  }
  return expressions.join("&&");
}

async function searchPage(query, cursor, limit, filters, sortBy) {
  const page = pageNumber(cursor);
  const size = Math.max(1, Math.min(Number(limit) || 20, 100));
  const params = [
    `q=${encodeURIComponent(query || "*")}`,
    "query_by=title,otherNames",
    `page=${page}`,
    `per_page=${size}`,
    `filter_by=${encodeURIComponent(filterExpression(filters))}`
  ];
  if (sortBy) params.push(`sort_by=${encodeURIComponent(sortBy)}`);
  const result = await getJson(`${ATSU_SEARCH}?${params.join("&")}`);
  const hits = Array.isArray(result.hits) ? result.hits : [];
  const hasNextPage = page * size < Number(result.found || 0);
  return {
    items: hits.map(hit => searchItem(hit.document || {})),
    nextCursor: hasNextPage ? String(page + 1) : null,
    hasNextPage
  };
}

function embeddedJson(html, variableName) {
  const marker = `window.${variableName} =`;
  const start = html.indexOf(marker);
  if (start < 0) throw extensionError(`Missing ${variableName} data`, false);
  const jsonStart = html.indexOf("{", start + marker.length);
  if (jsonStart < 0) throw extensionError(`Empty ${variableName} data`, false);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = jsonStart; i < html.length; i += 1) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return JSON.parse(html.slice(jsonStart, i + 1));
  }
  throw extensionError(`Invalid ${variableName} data`, false);
}

function chapterKey(mangaId, chapterId) {
  return `${mangaId}:${chapterId}`;
}

function splitChapterKey(value) {
  const separator = String(value).indexOf(":");
  if (separator < 1) throw new Tamuro.ExtensionError("INVALID_REQUEST", "Invalid Atsumaru chapter ID", false);
  return [String(value).slice(0, separator), String(value).slice(separator + 1)];
}

Tamuro.registerSource({
  async getPopularManga({ cursor, limit }) {
    return searchPage("*", cursor, limit, null, "views:desc");
  },

  async getLatestManga({ cursor, limit }) {
    return searchPage("*", cursor, limit, null, "dateAdded:desc");
  },

  async searchManga({ query, cursor, limit, filters }) {
    return searchPage(query, cursor, limit, filters, null);
  },

  async getMangaDetails({ mangaId }) {
    const html = await get(`${ATSU_BASE}/manga/${encodeURIComponent(mangaId)}`);
    const root = embeddedJson(html, "mangaPage");
    const manga = root.mangaPage || root;
    const people = Array.isArray(manga.authors) ? manga.authors : [];
    const names = list => (Array.isArray(list) ? list.map(item => item.name || item).filter(Boolean) : []);
    return {
      id: String(manga.id || mangaId),
      title: manga.title || manga.englishTitle || "Untitled",
      url: `${ATSU_BASE}/manga/${encodeURIComponent(mangaId)}`,
      cover: coverFrom(manga.poster),
      alternativeTitles: names(manga.otherNames),
      authors: people.filter(person => String(person.type).toLowerCase() === "author").map(person => person.name),
      artists: people.filter(person => String(person.type).toLowerCase() === "artist").map(person => person.name),
      genres: names(manga.genres).concat(names(manga.tags)),
      description: manga.synopsis || "",
      status: normalizeStatus(manga.status),
      type: normalizeType(manga.type),
      year: manga.releaseYear || (manga.released ? new Date(manga.released).getUTCFullYear() : null),
      nsfw: manga.isAdult === true
    };
  },

  async getChapters({ mangaId }) {
    const data = await getJson(`${ATSU_BASE}/api/manga/allChapters?mangaId=${encodeURIComponent(mangaId)}`);
    const chapters = Array.isArray(data.chapters) ? data.chapters : [];
    return chapters.map(chapter => ({
      id: chapterKey(mangaId, chapter.id),
      name: chapter.title || `Chapter ${chapter.number}`,
      url: `${ATSU_BASE}/read/${encodeURIComponent(mangaId)}/${encodeURIComponent(chapter.id)}`,
      chapterNumber: Number.isFinite(Number(chapter.number)) ? Number(chapter.number) : null,
      volumeNumber: null,
      scanlator: null,
      language: "en",
      uploadedAt: chapter.createdAt ? new Date(chapter.createdAt).toISOString() : null
    }));
  },

  async getPages({ chapterId }) {
    const ids = splitChapterKey(chapterId);
    const data = await getJson(`${ATSU_BASE}/api/read/chapter?mangaId=${encodeURIComponent(ids[0])}&chapterId=${encodeURIComponent(ids[1])}`);
    const pages = data.readChapter && Array.isArray(data.readChapter.pages) ? data.readChapter.pages : [];
    return pages.map((page, index) => ({
      index,
      image: { url: assetUrl(page.image) }
    }));
  },

  async getFilters() {
    return [
      { id: "showAdultContent", type: "toggle", name: "Show adult content", defaultValue: false },
      { id: "types", type: "multiSelect", name: "Type", options: ["Manga", "Manhwa", "Manhua"] },
      { id: "statuses", type: "multiSelect", name: "Status", options: ["Ongoing", "Completed", "Hiatus", "Cancelled"] }
    ];
  }
});
