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

const CDP_URL = process.env.PERPLEXITY_CDP || 'http://127.0.0.1:18800';
const ORIGIN = 'https://www.perplexity.ai';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36';

// Network.getCookies lives on a PAGE target: the browser-level endpoint only
// exposes Browser.*/Target.* domains.
async function getCookies() {
  const targets = await (await fetch(`${CDP_URL}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && /perplexity\.ai/.test(t.url || ''))
    || targets.find((t) => t.type === 'page');
  if (!page || !page.webSocketDebuggerUrl) throw new Error('no page target in the OpenClaw browser');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('could not open a CDP websocket'));
  });
  try {
    return await new Promise((resolve, reject) => {
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== 1) return;
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result.cookies || []);
      };
      ws.send(JSON.stringify({ id: 1, method: 'Network.getCookies', params: { urls: [ORIGIN] } }));
      setTimeout(() => reject(new Error('CDP getCookies timed out')), 15000);
    });
  } finally {
    ws.close();
  }
}

function csrfToken(cookies) {
  const hit = cookies.find((c) => c.name === 'next-auth.csrf-token' || /csrf/i.test(c.name));
  return hit ? hit.value.split('|')[0] : null;
}

async function internalFetch(pathname, cookies, init = {}) {
  const csrf = csrfToken(cookies);
  const res = await fetch(`${ORIGIN}${pathname}`, {
    ...init,
    redirect: 'manual',
    headers: {
      cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON (e.g. an HTML error page) */ }
  return { status: res.status, body, text };
}

function threadSlug(value) {
  const m = String(value).match(/(?:search|thread)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : String(value).replace(/^\/+|\/+$/g, '');
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
    const raw = content.answer != null ? content.answer : (content.markdown != null ? content.markdown : content.text);
    if (typeof raw !== 'string' || !raw.trim()) continue;
    try {
      const inner = JSON.parse(raw);
      if (inner && typeof inner === 'object' && typeof inner.answer === 'string') return inner.answer;
    } catch { /* not JSON — use the string as-is */ }
    return raw;
  }
  return '';
}

async function listThreads({ cookies, limit = 10, offset = 0 } = {}) {  const jar = cookies || await getCookies();
  const { status, body } = await internalFetch('/rest/thread/list_ask_threads', jar, {
    method: 'POST',
    body: JSON.stringify({ limit, offset, source: 'default' }),
  });
  if (status !== 200 || !Array.isArray(body)) {
    throw new Error(`thread list returned HTTP ${status}`);
  }
  return { cookies: jar, threads: body };
}

async function searchHistory(term, { limit = 10, pages = 3, perPage = 200 } = {}) {
  const jar = await getCookies();
  const needle = String(term || '').toLowerCase().trim();
  // No server-side thread search exists (list_ask_threads ignores a `query`
  // field, and the GraphQL endpoint only accepts allow-listed operations), so
  // scan large pages instead: the endpoint serves up to 200 per request.
  const hits = [];
  let skipped = 0;

  for (let page = 0; page < pages; page++) {
    let threads;
    try {
      ({ threads } = await listThreads({ cookies: jar, limit: perPage, offset: page * perPage }));
    } catch (e) {
      if (page === 0) throw e;
      break;
    }
    if (threads.length === 0) break;
    for (const t of threads) {
      if (skipped++ >= 600) break;
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
    if (hits.length >= limit) break;
  }
  return hits.slice(0, limit);
}

async function getThread(slugOrUrl, { cookies } = {}) {
  const jar = cookies || await getCookies();
  const slug = threadSlug(slugOrUrl);
  const { status, body } = await internalFetch(`/rest/thread/${slug}`, jar);
  if (status !== 200 || !body) throw new Error(`thread ${slug} returned HTTP ${status}`);
  return { cookies: jar, slug, thread: body };
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
    frontend_uuid: crypto.randomUUID(),
    mode,
    model_preference: modelPreference,
    is_related_query: false,
    is_sponsored: false,
    prompt_source: 'user',
    query_source: threadUrl ? 'followup' : 'user',
    is_incognito: false,
    time_from_first_type: 500,
    local_search_enabled: false,
    use_schematized_api: true,
    send_back_text_in_streaming_api: false,
    supported_block_use_cases: ASK_BLOCK_USE_CASES,
    source: 'default',
    always_search_override: false,
    override_no_search: false,
    version: '2.18',
  };

  const res = await internalFetch('/rest/sse/perplexity_ask', jar, {
    method: 'POST',
    headers: { accept: 'text/event-stream' },
    body: JSON.stringify({ params, query_str: query }),
  });
  if (res.status !== 200) {
    throw new Error(`perplexity_ask returned HTTP ${res.status}`);
  }
  const parsed = parseAskStream(res.text);
  let answer = parsed.answer;
  const answerSlug = parsed.slug || slug;
  if ((!answer || !answer.trim()) && answerSlug) {
    // The stream sometimes carries only the plan/search blocks; the finished text
    // then lands on the thread itself, so read it back before giving up.
    try {
      const read = await latestAnswer(answerSlug, { cookies: jar });
      if (read.answer && read.answer.trim()) answer = read.answer;
    } catch { /* keep the empty answer; the caller can retry */ }
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
  const { status, body } = await internalFetch(
    `/rest/discover/feed?limit=${limit}&offset=${offset}&version=2.18&source=default`, jar);
  if (status !== 200 || !body) throw new Error(`discover feed returned HTTP ${status}`);
  const items = Array.isArray(body.items) ? body.items : [];
  return { cookies: jar, items: items.map(storyFrom), nextToken: body.next_token || null };
}

async function discoverTopics({ cookies } = {}) {
  const jar = cookies || await getCookies();
  const { status, body } = await internalFetch('/rest/discover/topics?version=2.18&source=default', jar);
  if (status !== 200 || !body) throw new Error(`discover topics returned HTTP ${status}`);
  const all = Array.isArray(body.all_topics) ? body.all_topics : [];
  const selected = Array.isArray(body.user_selected_topics) ? body.user_selected_topics : [];
  return {
    cookies: jar,
    selected: selected.map((t) => t.topic || t.title || t.key || String(t)),
    all: all.map((t) => t.topic || t.title || t.key || String(t)),
  };
}

// --- Models (no UI) ---------------------------------------------------------

async function listModels({ cookies } = {}) {
  const jar = cookies || await getCookies();
  const { status, body } = await internalFetch('/rest/models/config/v2?version=2.18&source=default', jar);
  if (status !== 200 || !body) throw new Error(`model config returned HTTP ${status}`);
  const models = body.models || {};
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
    defaults: body.default_models || null,
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