'use strict';
// Session API verbs: threads, ask, history, discover and models. All transport
// (CDP cookies, CSRF pairing, bounded fetch, failure classification) comes from
// session-core.js — this module is the endpoint surface only.
const {
  API_VERSION, ORIGIN, getCookies, internalFetch, failureReason,
  isAuthFailure, toInt, threadSlug, entryAnswer,
} = require('./session-core.js');

async function listThreads({ cookies, limit = 10, offset = 0 } = {}) {
  const jar = cookies || await getCookies();
  const safeLimit = toInt(limit, 10);
  const safeOffset = toInt(offset, 0);
  const res = await internalFetch('/rest/thread/list_ask_threads', jar, {
    method: 'POST',
    body: JSON.stringify({ limit: safeLimit, offset: safeOffset, source: 'default' }),
  });
  if (res.status !== 200 || !Array.isArray(res.body)) throw failureReason(res, 'thread list');
  return { cookies: jar, threads: res.body };
}

async function searchHistory(term, { limit = 10, pages = 3, perPage = 200 } = {}) {
  const jar = await getCookies();
  const needle = String(term || '').toLowerCase().trim();
  const safeLimit = toInt(limit, 10);
  const safePages = toInt(pages, 3);
  const safePerPage = Math.min(toInt(perPage, 200), 200);
  // No server-side thread search exists (list_ask_threads ignores a `query`
  // field, and the GraphQL endpoint only accepts allow-listed operations), so
  // scan large pages instead: the endpoint serves up to 200 per request.
  const hits = [];
  let skipped = 0;
  let truncated = false;
  const MAX_SCAN = 600;

  for (let page = 0; page < safePages; page++) {
    let threads;
    try {
      ({ threads } = await listThreads({ cookies: jar, limit: safePerPage, offset: page * safePerPage }));
    } catch (e) {
      // A transient failure mid-scan can keep the partial hits, but an expired
      // session (or any auth/redirect failure) must surface, not look like
      // "no more results".
      if (page === 0 || isAuthFailure(e)) throw e;
      truncated = true; // partial: the caller must be able to tell
      break;
    }
    if (threads.length === 0) break;
    let hitCap = false;
    for (const t of threads) {
      if (skipped >= MAX_SCAN) { hitCap = true; break; }
      skipped++;
      const haystack = `${(t && t.title) || ''} ${(t && t.query_str) || ''} ${(t && t.answer_preview) || ''}`.toLowerCase();
      if (t && typeof t === 'object' && (!needle || haystack.includes(needle))) {
        hits.push({
          title: t.title || '(untitled)',
          slug: t.slug,
          url: `${ORIGIN}/search/${t.slug}`,
          updated_at: t.last_query_datetime || null,
          query_count: t.query_count || null,
        });
      }
    }
    if (hitCap) truncated = true;
    if (hitCap || hits.length >= safeLimit) {
      // Stopping for the caller's limit (or the scan cap) while pages are
      // still left means matches may remain unscanned: the result is partial
      // even though it is exactly what was asked for. On the last page there
      // is nothing left to scan, so it stays complete.
      if (page < safePages - 1) truncated = true;
      break;
    }
    // The loop can also end by exhausting the page budget. If that last page
    // came back full, more threads may exist beyond what we scanned, so the
    // result is partial and the caller must be told.
    if (page === safePages - 1 && threads.length >= safePerPage) truncated = true;
  }
  // An object, not a decorated array: JSON.stringify drops non-index array
  // properties, so the truncation flag would vanish for API consumers.
  return { hits: hits.slice(0, safeLimit), truncated };
}
async function getThread(slugOrUrl, { cookies } = {}) {
  const jar = cookies || await getCookies();
  const slug = threadSlug(slugOrUrl);
  const res = await internalFetch(`/rest/thread/${slug}`, jar);
  if (res.status !== 200 || !res.body) throw failureReason(res, `thread ${slug}`);
  return { cookies: jar, slug, thread: res.body };
}

// Latest answer text in a thread — used to read back a chat follow-up without
// scraping the DOM.
async function latestAnswer(slugOrUrl, { cookies, minEntries = 1 } = {}) {
  const { thread, slug } = await getThread(slugOrUrl, { cookies });
  const entries = Array.isArray(thread.entries) ? thread.entries : [];
  if (entries.length < minEntries) return { slug, answer: '', entries: entries.length };
  // Never walk back past the entries the caller had already seen: a new entry
  // that is not filled in yet would otherwise surface the *previous* turn's
  // answer as this turn's reply.
  const start = Math.max(0, Math.min(minEntries - 1, entries.length - 1));
  for (let i = entries.length - 1; i >= start; i--) {
    const answer = entryAnswer(entries[i]);
    if (answer) return { slug, answer, entries: entries.length };
  }
  return { slug, answer: '', entries: entries.length };
}

// Block use cases the web client advertises. They are passed through verbatim
// from a captured browser request so the server returns the same block set.
const ASK_BLOCK_USE_CASES = [
  'answer_modes', 'media_items', 'inline_entity_cards', 'place_widgets',
  'finance_widgets', 'sports_widgets', 'news_widgets', 'shopping_widgets',
  'jobs_widgets', 'search_result_widgets', 'inline_images', 'inline_assets',
  'placeholder_cards', 'diff_blocks', 'entity_group_v2', 'refinement_filters',
  'canvas_mode', 'maps_preview', 'answer_tabs', 'price_comparison_widgets',
  'preserve_latex', 'generic_onboarding_widgets', 'in_context_suggestions',
  'pending_followups', 'inline_claims', 'unified_assets', 'workflow_steps',
  'workflow_widgets', 'navigation_results', 'background_agents',
];

// The ask stream is a series of `data:` lines carrying JSON. Per the SSE spec a
// frame may spread its payload over several `data:` lines (joined with \n), but
// this endpoint also emits one JSON object per line — so try the joined form
// first and fall back to per-line parsing.
function parseAskStream(text) {
  let answer = '';
  let slug = null;

  const handlePayload = (payload) => {
    if (payload.thread_url_slug) slug = payload.thread_url_slug;
    const blocks = payload.blocks;
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      const markdown = block && block.markdown_block;
      if (markdown && typeof markdown.answer === 'string' && markdown.answer.trim()) {
        answer = markdown.answer;
      }
    }
  };

  const consume = (raw) => {
    if (!raw || raw === '[DONE]') return;
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    handlePayload(payload);
  };

  // Blank line separates frames; a frame's payload is the joined data lines.
  for (const frame of String(text || '').split(/\r?\n\r?\n/)) {
    const dataLines = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0) continue;
    if (dataLines.length === 1) {
      consume(dataLines[0].trim());
      continue;
    }
    const joined = dataLines.join('\n').trim();
    let parsedJoined = false;
    try { JSON.parse(joined); parsedJoined = true; } catch { /* not one object */ }
    if (parsedJoined) consume(joined);
    else for (const line of dataLines) consume(line.trim());
  }
  return { answer, slug };
}

// Submit a query entirely through the session layer — no browser UI, so none of
// the composer/menu/streaming fragility applies. Thread-scoped tokens come from
// the thread itself.
async function submitAsk(query, { threadUrl = null, cookies, modelPreference = 'pplx_alpha', mode = 'copilot' } = {}) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('query must be a non-empty string');
  }
  const jar = cookies || await getCookies();
  let last = {};
  let slug = null;
  let entriesBefore = 0;
  if (threadUrl) {
    const got = await getThread(threadUrl, { cookies: jar });
    slug = got.slug;
    const entries = Array.isArray(got.thread.entries) ? got.thread.entries : [];
    entriesBefore = entries.length;
    last = entries[entries.length - 1] || {};
  }

  const params = {
    last_backend_uuid: last.backend_uuid || null,
    read_write_token: last.read_write_token || null,
    attachments: [],
    language: process.env.PPLX_LANGUAGE || 'en-US',
    timezone: process.env.PPLX_TIMEZONE || 'UTC',
    search_focus: 'internet',
    sources: ['web'],
    frontend_uuid: randomUUID(),
    mode,
    model_preference: modelPreference,
    is_related_query: false,
    is_sponsored: false,
    prompt_source: 'user',
    // Only a real thread continuation is a follow-up; a new thread must not claim
    // to be one (the server relies on this for placement).
    query_source: threadUrl && last.read_write_token ? 'followup' : 'user',
    is_incognito: false,
    time_from_first_type: 500,
    local_search_enabled: false,
    use_schematized_api: true,
    send_back_text_in_streaming_api: false,
    supported_block_use_cases: ASK_BLOCK_USE_CASES,
    source: 'default',
    always_search_override: false,
    override_no_search: false,
    version: API_VERSION,
  };

  const res = await internalFetch('/rest/sse/perplexity_ask', jar, {
    method: 'POST',
    headers: { accept: 'text/event-stream' },
    body: JSON.stringify({ params, query_str: query }),
  });
  if (res.status !== 200) throw failureReason(res, 'perplexity_ask');
  const parsed = parseAskStream(res.text);
  let answer = parsed.answer;
  const answerSlug = parsed.slug || slug;
  if ((!answer || !answer.trim()) && answerSlug) {
    // The stream sometimes carries only the plan/search blocks; the finished text
    // then lands on the thread itself, so read it back before giving up.
    try {
      // Require a NEW entry: if the ask produced none, the read-back would
      // otherwise return the previous turn's answer as if it were the reply.
      const read = await latestAnswer(answerSlug, { cookies: jar, minEntries: entriesBefore + 1 });
      if (read.answer && read.answer.trim()) answer = read.answer;
    } catch (e) {
      // No silent fallback here: a read-back that throws (HTTP 500, timeout,
      // network error) is a real failure, and reporting it as an empty answer
      // would hide it. `latestAnswer` signals "no answer yet" by returning an
      // empty string, so reaching this catch always means the read broke.
      throw e;
    }
  }
  return { answer, slug: answerSlug, cookies: jar };
}

// --- Discover (no UI) -------------------------------------------------------

function storyFrom(item) {
  if (!item || typeof item !== 'object') return null;
  const preview = Array.isArray(item.web_results_preview && item.web_results_preview.first_urls)
    ? item.web_results_preview.first_urls[0]
    : null;
  return {
    title: item.title || item.short_title || '(untitled)',
    summary: item.summary || item.description || null,
    url: item.url || (item.slug ? `${ORIGIN}/discover/${item.slug}` : preview),
    source: item.domain_name || null,
    published: item.published_timestamp || item.updated_datetime || null,
    item_type: item.item_type || null,
  };
}

async function discoverFeed({ limit = 20, offset = 0, cookies } = {}) {
  const jar = cookies || await getCookies();
  const safeLimit = toInt(limit, 20);
  const safeOffset = toInt(offset, 0);
  const res = await internalFetch(
    `/rest/discover/feed?limit=${safeLimit}&offset=${safeOffset}&version=${API_VERSION}&source=default`, jar);
  if (res.status !== 200 || !res.body) throw failureReason(res, 'discover feed');
  const items = Array.isArray(res.body.items) ? res.body.items : [];
  return { cookies: jar, items: items.map(storyFrom).filter(Boolean), nextToken: res.body.next_token || null };
}

async function discoverTopics({ cookies } = {}) {
  const jar = cookies || await getCookies();
  const res = await internalFetch(`/rest/discover/topics?version=${API_VERSION}&source=default`, jar);
  if (res.status !== 200 || !res.body) throw failureReason(res, 'discover topics');
  const all = Array.isArray(res.body.all_topics) ? res.body.all_topics : [];
  const selected = Array.isArray(res.body.user_selected_topics) ? res.body.user_selected_topics : [];
  return {
    cookies: jar,
    selected: selected.map((t) => t.topic || t.title || t.key || String(t)),
    all: all.map((t) => t.topic || t.title || t.key || String(t)),
  };
}

// --- Models (no UI) ---------------------------------------------------------

async function listModels({ cookies } = {}) {
  const jar = cookies || await getCookies();
  const res = await internalFetch(`/rest/models/config/v2?version=${API_VERSION}&source=default`, jar);
  if (res.status !== 200 || !res.body) throw failureReason(res, 'model config');
  const models = res.body.models || {};
  const entries = Array.isArray(models)
    // Spread first: a trailing `...m` would clobber the computed fallback, and
    // the server sometimes sends `id: null` next to a usable `model` field.
    ? models.map((m, i) => ({ ...m, id: (m && (m.id || m.model)) || String(i) }))
    : Object.entries(models).map(([id, m]) => ({ ...m, id }));
  return {
    cookies: jar,
    models: entries.map((m) => ({
      id: m.id,
      label: m.label || m.short_name || m.id,
      description: m.description || null,
      mode: m.mode || null,
      provider: m.provider || null,
    })),
    defaults: res.body.default_models || null,
  };
}

module.exports = {
  listThreads,
  searchHistory,
  getThread,
  latestAnswer,
  submitAsk,
  parseAskStream,
  discoverFeed,
  discoverTopics,
  listModels,
};
