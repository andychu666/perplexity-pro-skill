'use strict';
// Shared Perplexity session layer.
//
// The OpenClaw-managed Chrome profile already holds a signed-in Perplexity Pro
// session. Reading its cookies over CDP (and pairing the CSRF cookie with an
// `x-csrf-token` header) lets callers hit Perplexity's internal endpoints
// directly — no menu clicking, no composer typing, no waiting for a stream.
//
// Cookies are never printed and never written to disk.
//
// CommonJS so both perplexity-query.js (CJS) and the .mjs helpers can use it.

const { randomUUID } = require('node:crypto');

const CDP_URL = process.env.PERPLEXITY_CDP || 'http://127.0.0.1:18800';
const ORIGIN = 'https://www.perplexity.ai';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36';
const API_VERSION = '2.18';
const CDP_TIMEOUT_MS = 15000;
const HTTP_TIMEOUT_MS = 60000; // ask streams can legitimately take a while
const MAX_BODY_BYTES = 16 * 1048576; // guard against a runaway buffered response

// Network.getCookies lives on a PAGE target: the browser-level endpoint only
// exposes Browser.*/Target.* domains.
async function getCookies() {
  // Node <21 has no global WebSocket; fail with a reason instead of a bare
  // ReferenceError.
  if (typeof WebSocket === 'undefined') {
    throw new Error('no global WebSocket (needs Node 21+) - cannot read the browser session');
  }

  const listRes = await fetch(`${CDP_URL}/json/list`, { signal: AbortSignal.timeout(CDP_TIMEOUT_MS) });
  if (!listRes.ok) throw new Error(`CDP /json/list returned HTTP ${listRes.status}`);
  const targets = await listRes.json();
  if (!Array.isArray(targets)) throw new Error('CDP /json/list did not return an array');

  // Match the real host, not a substring: a tab on perplexity.ai.evil.com must
  // never be mistaken for the logged-in Perplexity session.
  const isPerplexityUrl = (u) => {
    try {
      const host = new URL(u).hostname.toLowerCase();
      return host === 'perplexity.ai' || host === 'www.perplexity.ai' || host.endsWith('.perplexity.ai');
    } catch {
      return false;
    }
  };
  let page = targets.find((t) => t.type === 'page' && isPerplexityUrl(t.url || ''));
  if (!page) {
    // No fallback to an arbitrary tab: Network.getCookies is partitioned by
    // browser context, so an incognito/other-profile tab can answer with the
    // wrong (or no) jar.
    throw new Error('no Perplexity tab found in the OpenClaw browser; open https://www.perplexity.ai there first');
  }
  if (!page.webSocketDebuggerUrl) throw new Error('the Perplexity tab exposes no debugger socket');

  let ws;
  try {
    ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch (e) {
    // Must not escape the finally block as a bare ReferenceError.
    throw new Error(`could not create a CDP websocket: ${e.message}`);
  }
  ws.onerror = () => {};   // handled by the promises below; avoids an unhandled 'error'
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket handshake timed out')), CDP_TIMEOUT_MS);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('could not open a CDP websocket')); };
    });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP getCookies timed out')), CDP_TIMEOUT_MS);
      // Settle once: late frames, a late timeout or a dropped socket must not
      // double-settle (and a socket drop must not hang until the timeout).
      const settle = (fn, value) => {
        clearTimeout(timer);
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        fn(value);
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; } // keepalive/partial frame
        if (!msg || msg.id !== 1) return;
        if (msg.error) settle(reject, new Error(JSON.stringify(msg.error)));
        else settle(resolve, (msg.result && msg.result.cookies) || []);
      };
      ws.onclose = () => settle(reject, new Error('CDP websocket closed before replying'));
      ws.onerror = () => settle(reject, new Error('CDP websocket errored before replying'));
      ws.send(JSON.stringify({ id: 1, method: 'Network.getCookies', params: { urls: [ORIGIN] } }));
    });
  } finally {
    try { ws.close(); } catch { /* already closed */ }
  }
}

function csrfToken(cookies) {
  if (!Array.isArray(cookies)) return null;
  // Prefer the exact cookie name; the regex is only a fallback.
  const hit = cookies.find((c) => c && c.name === 'next-auth.csrf-token')
    || cookies.find((c) => c && typeof c.name === 'string' && /csrf/i.test(c.name));
  if (!hit || typeof hit.value !== 'string') return null;
  return hit.value.split('|')[0] || null;
}

/** Cookie header value: skip malformed entries and strip anything that could
 *  inject a header separator. */
function cookieHeader(cookies) {
  const jar = Array.isArray(cookies) ? cookies : [];
  return jar
    .filter((c) => c && typeof c.name === 'string' && /^[\w.\-]+$/.test(c.name))
    .map((c) => `${c.name}=${String(c.value === null || c.value === undefined ? '' : c.value).replace(/[\r\n;]/g, '')}`)
    .join('; ');
}

async function internalFetch(pathname, cookies, init = {}) {
  const csrf = csrfToken(cookies);
  const res = await fetch(`${ORIGIN}${pathname}`, {
    ...init,
    redirect: 'manual',
    // Bounded: an unbounded fetch here would hang the caller forever. A caller
    // signal is combined with the timeout instead of replacing it.
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)])
      : AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: (() => {
      // Headers normalises case, so a caller passing `Cookie`/`X-CSRF-Token`
      // cannot slip past the guard below (HTTP header names are case-insensitive).
      const h = new Headers(init.headers || {});
      h.set('user-agent', UA);
      h.set('accept', 'application/json, text/plain, */*');
      if (init.body) h.set('content-type', 'application/json');
      // Auth headers are applied last: a caller must not be able to clobber
      // them (that would break the session or misattribute the request).
      h.set('cookie', cookieHeader(cookies));
      if (csrf) h.set('x-csrf-token', csrf);
      return h;
    })(),
  });
  // res.text() buffers the whole body: cap it so a runaway stream (or a huge
  // error page) cannot exhaust memory.
  const text = await readCapped(res, MAX_BODY_BYTES);
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON (e.g. an HTML error page) */ }
  return { status: res.status, body, text };
}

async function readCapped(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') return res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* best effort */ }
      throw new Error(`response exceeded ${Math.round(maxBytes / 1048576)} MiB`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Uniform failure reporting: redirects (an expired session) and 401/403 are the
// cases a caller must be able to tell apart from a plain 500.
function failureReason(res, what) {
  const snippet = String(res.text || '').replace(/\s+/g, ' ').slice(0, 160);
  if (res.status >= 300 && res.status < 400) {
    return new Error(`${what} redirected (HTTP ${res.status}) - the Perplexity session looks expired; re-login in the OpenClaw browser`);
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(`${what} refused (HTTP ${res.status}) - session may have expired or lack permission${snippet ? `: ${snippet}` : ''}`);
  }
  return new Error(`${what} returned HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
}

function threadSlug(value) {
  const raw = String(value).trim();
  // Match the slug at a path boundary AND at the end of the value, so
  // "search/abc/def" is rejected instead of silently truncating to "abc".
  const m = raw.match(/(?:^|\/)(?:search|thread)\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/);
  const slug = m ? m[1] : raw.replace(/^\/+|\/+$/g, '');
  // Reject anything that is not a plain slug: the value ends up in a URL path.
  if (!/^[A-Za-z0-9_-]+$/.test(slug)) {
    throw new Error(`invalid thread reference: ${raw.slice(0, 80)}`);
  }
  return slug;
}

function parseSteps(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// Thread entries carry no plain answer string: `entry.text` is a JSON string of
// steps, and the FINAL step's content.answer is itself JSON like
// {"answer": "...", ...}. Unwrap both levels.
function entryAnswer(entry) {
  if (!entry) return '';
  for (const key of ['answer', 'markdown']) {
    if (typeof entry[key] === 'string' && entry[key].trim()) return entry[key];
  }
  const steps = parseSteps(entry.text);
  for (let i = steps.length - 1; i >= 0; i--) {
    const content = steps[i] && steps[i].content;
    if (!content || typeof content !== 'object') continue;
    const raw = content.answer !== undefined ? content.answer
      : content.markdown !== undefined ? content.markdown
      : content.text;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    try {
      const inner = JSON.parse(raw);
      if (inner && typeof inner === 'object' && typeof inner.answer === 'string') return inner.answer;
    } catch { /* not JSON — use the string as-is */ }
    return raw;
  }
  return '';
}

async function listThreads({ cookies, limit = 10, offset = 0 } = {}) {
  const jar = cookies || await getCookies();
  const res = await internalFetch('/rest/thread/list_ask_threads', jar, {
    method: 'POST',
    body: JSON.stringify({ limit, offset, source: 'default' }),
  });
  if (res.status !== 200 || !Array.isArray(res.body)) throw failureReason(res, 'thread list');
  return { cookies: jar, threads: res.body };
}

async function searchHistory(term, { limit = 10, pages = 3, perPage = 200 } = {}) {
  const jar = await getCookies();
  const needle = String(term || '').toLowerCase().trim();
  // No server-side thread search exists (list_ask_threads ignores a `query`
  // field, and the GraphQL endpoint only accepts allow-listed operations), so
  // scan large pages instead: the endpoint serves up to 200 per request.
  const hits = [];
  let skipped = 0;
  const MAX_SCAN = 600;

  for (let page = 0; page < pages; page++) {
    let threads;
    try {
      ({ threads } = await listThreads({ cookies: jar, limit: perPage, offset: page * perPage }));
    } catch (e) {
      // A transient failure mid-scan can keep the partial hits, but an expired
      // session (or any auth/redirect failure) must surface, not look like
      // "no more results".
      if (page === 0 || /401|403|redirect|expired|refused/i.test(e.message)) throw e;
      break;
    }
    if (threads.length === 0) break;
    let hitCap = false;
    for (const t of threads) {
      // Stop scanning entirely at the cap: breaking only the inner loop would
      // keep fetching pages that can never be used.
      if (skipped >= MAX_SCAN) { hitCap = true; break; }
      skipped++;
      const haystack = `${t.title || ''} ${t.query_str || ''} ${t.answer_preview || ''}`.toLowerCase();
      if (!needle || haystack.includes(needle)) {
        hits.push({
          title: t.title || '(untitled)',
          slug: t.slug,
          url: `${ORIGIN}/search/${t.slug}`,
          updated_at: t.last_query_datetime || null,
          query_count: t.query_count || null,
        });
      }
    }
    if (hitCap || hits.length >= limit) break;
  }
  return hits.slice(0, limit);
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
  for (let i = entries.length - 1; i >= 0; i--) {
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

// The ask stream is a series of `data: {...}` lines; the finished answer shows up
// in blocks as markdown_block.answer (types: ask_text / ask_text_0_markdown).
function parseAskStream(text) {
  let answer = '';
  let slug = null;
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    let payload;
    try { payload = JSON.parse(raw); } catch { continue; }
    if (payload.thread_url_slug) slug = payload.thread_url_slug;
    const blocks = payload.blocks;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      const markdown = block && block.markdown_block;
      if (markdown && typeof markdown.answer === 'string' && markdown.answer.trim()) {
        answer = markdown.answer;
      }
    }
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
  if (threadUrl) {
    const got = await getThread(threadUrl, { cookies: jar });
    slug = got.slug;
    const entries = Array.isArray(got.thread.entries) ? got.thread.entries : [];
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
      const read = await latestAnswer(answerSlug, { cookies: jar });
      if (read.answer && read.answer.trim()) answer = read.answer;
    } catch (e) {
      // An empty read is fine, but an expired session must not be reported as
      // "empty answer".
      if (/401|403|redirect|expired|refused/i.test(e.message)) throw e;
    }
  }
  return { answer, slug: answerSlug, cookies: jar };
}

// --- Discover (no UI) -------------------------------------------------------

function storyFrom(item) {
  const preview = Array.isArray(item.web_results_preview?.first_urls) ? item.web_results_preview.first_urls[0] : null;
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
  const res = await internalFetch(
    `/rest/discover/feed?limit=${limit}&offset=${offset}&version=${API_VERSION}&source=default`, jar);
  if (res.status !== 200 || !res.body) throw failureReason(res, 'discover feed');
  const items = Array.isArray(res.body.items) ? res.body.items : [];
  return { cookies: jar, items: items.map(storyFrom), nextToken: res.body.next_token || null };
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
    ? models.map((m, i) => ({ id: m.id || m.model || String(i), ...m }))
    : Object.entries(models).map(([id, m]) => ({ id, ...m }));
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
  CDP_URL,
  ORIGIN,
  getCookies,
  csrfToken,
  internalFetch,
  threadSlug,
  entryAnswer,
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