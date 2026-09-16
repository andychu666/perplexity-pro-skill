#!/usr/bin/env node
// Reuse the logged-in Perplexity session instead of driving the UI.
//
// The OpenClaw-managed Chrome profile already holds a signed-in Perplexity Pro
// session. Reading its cookies over CDP (and the matching CSRF cookie as an
// `x-csrf-token` header) lets us call Perplexity's internal endpoints directly —
// no menu clicking, no composer typing, no waiting for a stream to settle.
//
// Cookies are never printed and never written to disk by this script.
//
// Usage:
//   perplexity-session.mjs --whoami
//   perplexity-session.mjs --thread <thread-url-or-slug>
//   perplexity-session.mjs --json --thread <...>
//
// Requires the OpenClaw browser to be running (default http://127.0.0.1:18800).

import { setTimeout as sleep } from 'node:timers/promises';

const CDP = process.env.PERPLEXITY_CDP || 'http://127.0.0.1:18800';
const ORIGIN = 'https://www.perplexity.ai';

function usage() {
  console.log(`Usage: perplexity-session.mjs --whoami
       perplexity-session.mjs [--json] --thread <thread-url-or-slug>

Reuses the logged-in Perplexity session (cookies read over CDP) to query internal
endpoints without driving the UI. Cookies are never printed.`);
}

function parseArgs(argv) {
  const opts = { whoami: false, thread: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--whoami') opts.whoami = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--thread') {
      opts.thread = argv[++i];
      if (!opts.thread) { console.error('Error: --thread needs a value'); process.exit(2); }
    } else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else { console.error(`Error: unknown option ${a}`); process.exit(2); }
  }
  if (!opts.whoami && !opts.thread) { usage(); process.exit(1); }
  return opts;
}

// Network.getCookies is exposed on a PAGE target, not the browser-level endpoint.
async function sessionCookies() {
  const targets = await (await fetch(`${CDP}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && /perplexity\.ai/.test(t.url || ''))
    || targets.find((t) => t.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('no page target in the OpenClaw browser');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('could not open a CDP websocket'));
  });
  try {
    const result = await new Promise((resolve, reject) => {
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== 1) return;
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      };
      ws.send(JSON.stringify({ id: 1, method: 'Network.getCookies', params: { urls: [ORIGIN] } }));
      setTimeout(() => reject(new Error('CDP getCookies timed out')), 15000);
    });
    return result.cookies || [];
  } finally {
    ws.close();
  }
}

function cookieHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

function csrfToken(cookies) {
  const hit = cookies.find((c) => c.name === 'next-auth.csrf-token' || /csrf/i.test(c.name));
  if (!hit) return null;
  return hit.value.split('|')[0];
}

async function internalFetch(pathname, cookies, init = {}) {
  const csrf = csrfToken(cookies);
  const res = await fetch(`${ORIGIN}${pathname}`, {
    ...init,
    redirect: 'manual',
    headers: {
      cookie: cookieHeader(cookies),
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
      accept: 'application/json, text/plain, */*',
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body, text };
}

function threadSlug(value) {
  const m = String(value).match(/(?:search|thread)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : String(value).replace(/^\/+|\/+$/g, '');
}

// Thread entries do not carry a plain answer string: `entry.text` is a JSON string
// holding the step list, and the FINAL step's content.answer is itself JSON like
// {"answer": "...", ...}. Dig both levels out instead of dumping raw JSON.
function parseSteps(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function entryAnswer(entry) {
  if (!entry) return '';
  for (const key of ['answer', 'markdown']) {
    if (typeof entry[key] === 'string' && entry[key].trim()) return entry[key];
  }
  const steps = parseSteps(entry.text);
  for (let i = steps.length - 1; i >= 0; i--) {
    const content = steps[i] && steps[i].content;
    if (!content || typeof content !== 'object') continue;
    const raw = content.answer ?? content.markdown ?? content.text;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    try {
      const inner = JSON.parse(raw);
      if (inner && typeof inner === 'object' && typeof inner.answer === 'string') return inner.answer;
    } catch { /* not JSON — use the string as-is */ }
    return raw;
  }
  return '';
}

const opts = parseArgs(process.argv.slice(2));

let cookies;
try {
  cookies = await sessionCookies();
} catch (e) {
  console.error(`Error: could not read the browser session (${e.message}). Is the OpenClaw browser running?`);
  process.exit(1);
}
if (cookies.length === 0) {
  console.error('Error: no Perplexity cookies found — is the openclaw profile logged in?');
  process.exit(1);
}

if (opts.whoami) {
  const { status, body } = await internalFetch('/rest/user/info', cookies);
  if (status !== 200) {
    console.error(`Error: /rest/user/info returned HTTP ${status} (session may have expired)`);
    process.exit(1);
  }
  if (opts.json) {
    console.log(JSON.stringify(body, null, 2));
  } else {
    console.log('session: OK');
    console.log('cookies:', cookies.length, '| csrf:', csrfToken(cookies) ? 'present' : 'missing');
    console.log('host:', body?.home_host ?? '(unknown)');
  }
}

if (opts.thread) {
  const slug = threadSlug(opts.thread);
  const { status, body } = await internalFetch(`/rest/thread/${slug}`, cookies);
  if (status !== 200) {
    console.error(`Error: /rest/thread/${slug} returned HTTP ${status}`);
    process.exit(1);
  }
  if (opts.json) {
    console.log(JSON.stringify(body, null, 2));
  } else {
    const entries = Array.isArray(body?.entries) ? body.entries : [];
    console.log('thread:', body?.slug || slug);
    console.log('title:', body?.title || '(untitled)');
    console.log('entries:', entries.length);
    for (const e of entries.slice(-3)) {
      const q = (e.query_str || e.query || '').slice(0, 70);
      const a = entryAnswer(e).replace(/\s+/g, ' ').slice(0, 90);
      console.log(`  Q: ${q}`);
      if (a) console.log(`  A: ${a}...`);
    }
  }
}
