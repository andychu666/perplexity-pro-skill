#!/usr/bin/env node
// Reuse the logged-in Perplexity session instead of driving the UI.
//
// The OpenClaw-managed Chrome profile already holds a signed-in Perplexity Pro
// session. Reading its cookies over CDP (and pairing the CSRF cookie with an
// `x-csrf-token` header) lets us call Perplexity's internal endpoints directly —
// no menu clicking, no composer typing, no waiting for a stream to settle.
//
// Cookies are never printed and never written to disk by this script.
//
// Usage:
//   perplexity-session.mjs --whoami
//   perplexity-session.mjs --thread <thread-url-or-slug>
//   perplexity-session.mjs --history "<term>" [--limit N]
//   perplexity-session.mjs --json <action>
//
// Requires the OpenClaw browser to be running (default http://127.0.0.1:18800).

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const session = require('./session.js');

function usage() {
  console.log(`Usage: perplexity-session.mjs --whoami
       perplexity-session.mjs [--json] --thread <thread-url-or-slug>
       perplexity-session.mjs [--json] --ask "<question>" --thread <url>
       perplexity-session.mjs [--json] --history "<term>" [--limit N]

Reuses the logged-in Perplexity session (cookies read over CDP) to query internal
endpoints without driving the UI. Cookies are never printed.`);
}

function parseArgs(argv) {
  const opts = { whoami: false, thread: null, history: null, ask: null, json: false, limit: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (name) => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) { console.error(`Error: ${name} needs a value`); process.exit(2); }
      return v;
    };
    if (a === '--whoami') opts.whoami = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--thread') opts.thread = need(a);
    else if (a === '--history' || a === '--library') opts.history = need(a);
    else if (a === '--ask') opts.ask = need(a);
    else if (a === '--limit') {
      const n = Number(need(a));
      if (!Number.isFinite(n) || n <= 0) { console.error('Error: --limit needs a positive integer'); process.exit(2); }
      opts.limit = n;
    } else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else { console.error(`Error: unknown option ${a}`); process.exit(2); }
  }
  if (!opts.whoami && !opts.thread && !opts.history && !opts.ask) { usage(); process.exit(1); }
  if (opts.ask && !opts.thread) { console.error('Error: --ask needs --thread <url>'); process.exit(2); }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

let cookies;
try {
  cookies = await session.getCookies();
} catch (e) {
  console.error(`Error: could not read the browser session (${e.message}). Is the OpenClaw browser running?`);
  process.exit(1);
}
if (cookies.length === 0) {
  console.error('Error: no Perplexity cookies found — is the openclaw profile logged in?');
  process.exit(1);
}

if (opts.whoami) {
  const { status, body } = await session.internalFetch('/rest/user/info', cookies);
  if (status !== 200) {
    console.error(`Error: /rest/user/info returned HTTP ${status} (session may have expired)`);
    process.exit(1);
  }
  if (opts.json) {
    console.log(JSON.stringify(body, null, 2));
  } else {
    console.log('session: OK');
    console.log('cookies:', cookies.length, '| csrf:', session.csrfToken(cookies) ? 'present' : 'missing');
    console.log('host:', (body && body.home_host) || '(unknown)');
  }
}

if (opts.thread) {
  let result;
  try {
    result = await session.getThread(opts.thread, { cookies });
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
  const { thread, slug } = result;
  if (opts.json) {
    console.log(JSON.stringify(thread, null, 2));
  } else {
    const entries = Array.isArray(thread.entries) ? thread.entries : [];
    console.log('thread:', thread.slug || slug);
    console.log('title:', thread.title || '(untitled)');
    console.log('entries:', entries.length);
    for (const e of entries.slice(-3)) {
      const q = (e.query_str || e.query || '').replace(/\s+/g, ' ').slice(0, 70);
      const a = session.entryAnswer(e).replace(/\s+/g, ' ').slice(0, 90);
      console.log(`  Q: ${q}`);
      if (a) console.log(`  A: ${a}${a.length >= 90 ? '...' : ''}`);
    }
  }
}

if (opts.ask) {
  let result;
  try {
    result = await session.submitAsk(opts.ask, { threadUrl: opts.thread, cookies });
  } catch (e) {
    console.error(`Error: session ask failed (${e.message})`);
    process.exit(1);
  }
  if (opts.json) {
    console.log(JSON.stringify({ query: opts.ask, slug: result.slug, answer: result.answer }, null, 2));
  } else {
    console.log(result.answer || '[no answer]');
    if (result.slug) console.log(`\nthread: ${session.ORIGIN}/search/${result.slug}`);
  }
}

if (opts.history) {
  let hits;
  try {
    hits = await session.searchHistory(opts.history, { limit: opts.limit });
  } catch (e) {
    console.error(`Error: history search failed (${e.message})`);
    process.exit(1);
  }
  if (opts.json) {
    console.log(JSON.stringify({ term: opts.history, count: hits.length, threads: hits }, null, 2));
  } else {
    console.log(`history: "${opts.history}" -> ${hits.length} thread(s)`);
    for (const t of hits) {
      const when = (t.updated_at || '').slice(0, 19).replace('T', ' ');
      console.log(`  - ${t.title.slice(0, 70)}`);
      console.log(`    ${t.url}${when ? `  (${when})` : ''}`);
    }
  }
}
