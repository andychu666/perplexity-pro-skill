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

async function listThreads({ cookies, limit = 10, offset = 0 } = {}) {
  const jar = cookies || await getCookies();
  const { status, body } = await internalFetch('/rest/thread/list_ask_threads', jar, {
    method: 'POST',
    body: JSON.stringify({ limit, offset, source: 'default' }),
  });
  if (status !== 200 || !Array.isArray(body)) {
    throw new Error(`thread list returned HTTP ${status}`);
  }
  return { cookies: jar, threads: body };
}

async function searchHistory(term, { limit = 10, pages = 3 } = {}) {
  const jar = await getCookies();
  const needle = String(term || '').toLowerCase().trim();
  const perPage = 50;
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
      if (skipped++ >= 200) break;
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
};