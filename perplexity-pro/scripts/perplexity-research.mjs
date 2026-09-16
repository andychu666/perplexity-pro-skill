#!/usr/bin/env node
// Deep research via the official Perplexity Agent API (API-first path for --deep).
//
// Why: driving the Deep Research mode through the browser UI is fragile (the mode
// moved into the composer's "/" menu and must be selected on an empty composer),
// and a streamed report is easy to capture half-finished. The Agent API returns a
// finished report, supports presets, and can run as a background job.
//
// Usage:
//   perplexity-research.mjs --query "..." [--preset fast|low|medium|high|xhigh]
//   perplexity-research.mjs --resume <job_id>
//
// Options:
//   --preset        default medium            (high/xhigh run in background)
//   --background    force a background job
//   --resume ID     collect an existing background job instead of starting one
//   --output-dir    default $PPLX_OUTPUT_DIR or ./research-output
//   --stdout-preview N   report chars on stdout (default 1500, 0 = full)
//   --timeout SEC   default 900 for high/xhigh, else 120
//   --poll-interval SEC  background poll interval (default 10)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const API_URL = 'https://api.perplexity.ai/v1/agent';
const PRESETS = ['fast', 'low', 'medium', 'high', 'xhigh'];
const BACKGROUND_PRESETS = new Set(['high', 'xhigh']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'incomplete']);

function die(code, message, hint) {
  console.error(JSON.stringify({ error: { code, message, hint } }));
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    query: null, preset: 'medium', resume: null, background: false,
    outputDir: process.env.PPLX_OUTPUT_DIR || './research-output',
    stdoutPreview: 1500, timeout: null, pollInterval: 10,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (name) => {
      const v = argv[++i];
      if (v === undefined) die('ARGUMENT_ERROR', `${name} needs a value`, 'See --help.');
      return v;
    };
    if (a === '--query' || a === '-q') opts.query = need(a);
    else if (a === '--preset') opts.preset = need(a);
    else if (a === '--resume') opts.resume = need(a);
    else if (a === '--background') opts.background = true;
    else if (a === '--output-dir') opts.outputDir = need(a);
    else if (a === '--stdout-preview') opts.stdoutPreview = Number(need(a));
    else if (a === '--timeout') opts.timeout = Number(need(a));
    else if (a === '--poll-interval') opts.pollInterval = Number(need(a));
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else die('ARGUMENT_ERROR', `unknown option ${a}`, 'See --help.');
  }
  if (!opts.query && !opts.resume) die('ARGUMENT_ERROR', 'either --query or --resume is required', 'See --help.');
  if (!PRESETS.includes(opts.preset)) die('ARGUMENT_ERROR', `--preset must be one of ${PRESETS.join('|')}`, 'See --help.');
  if (opts.timeout === null) opts.timeout = BACKGROUND_PRESETS.has(opts.preset) ? 900 : 120;
  if (opts.background === false && BACKGROUND_PRESETS.has(opts.preset)) opts.background = true;
  return opts;
}

function usage() {
  console.log(`Usage: perplexity-research.mjs --query "..." [--preset ${PRESETS.join('|')}]
       perplexity-research.mjs --resume <job_id>

Presets: fast (seconds) · low (10-30s) · medium · high (minutes) · xhigh
high/xhigh run as background jobs and can be collected later with --resume.
The full report is written to --output-dir; stdout gets a preview + saved paths.`);
}

const opts = parseArgs(process.argv.slice(2));
const apiKey = process.env["PERPLEXITY_API_KEY"];
if (!apiKey) die('NO_API_KEY', 'PERPLEXITY_API_KEY environment variable not set', 'export PERPLEXITY_API_KEY=pplx-...');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(method, url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function reportText(payload) {
  const out = payload && payload.output;
  if (!Array.isArray(out)) return '';
  for (let i = out.length - 1; i >= 0; i--) {
    const item = out[i];
    if (item && item.type === 'message' && Array.isArray(item.content)) {
      const text = item.content
        .filter((c) => c && (c.type === 'output_text' || typeof c.text === 'string'))
        .map((c) => c.text || '')
        .join('\n')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

function sources(payload) {
  const out = (payload && payload.output) || [];
  const rows = [];
  for (const item of out) {
    if (item && item.type === 'search_results' && Array.isArray(item.results)) {
      for (const r of item.results) rows.push({ title: r.title || '', url: r.url || '', snippet: r.snippet || '' });
    }
  }
  return rows;
}

function slugify(text) {
  return (text || 'research').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'research';
}

async function poll(jobId, deadline) {
  let delay = Math.max(2, opts.pollInterval) * 1000;
  for (;;) {
    if (Date.now() > deadline) {
      die('TIMEOUT', `job ${jobId} did not finish within ${opts.timeout}s`,
        `The server-side job keeps running; collect it with --resume ${jobId}`);
    }
    const { status, json } = await request('GET', `${API_URL}/${jobId}`);
    if (status === 429 || status >= 500) {
      // Rate limited / transient: back off instead of failing the run.
      await sleep(delay);
      delay = Math.min(delay * 1.5, 30000);
      continue;
    }
    if (status >= 400 || !json) {
      die('API_ERROR', `poll failed with HTTP ${status}`, 'Retry with --resume.');
    }
    if (TERMINAL.has(json.status)) return json;
    process.stderr.write(`[research] job ${jobId}: ${json.status}\n`);
    await sleep(delay);
  }
}

const startedAt = new Date();
let payload;
if (opts.resume) {
  payload = await poll(opts.resume, Date.now() + opts.timeout * 1000);
} else {
  const body = { input: opts.query, preset: opts.preset };
  if (opts.background) body.background = true;
  const { status, json, text } = await request('POST', API_URL, body);
  if (status >= 400 || !json) {
    die('API_ERROR', `Agent API returned HTTP ${status}: ${(text || '').slice(0, 300)}`,
      'Check the API key and preset.');
  }
  payload = opts.background ? await poll(json.id, Date.now() + opts.timeout * 1000) : json;
}

const report = reportText(payload);
const jobId = payload.id || opts.resume || null;
const elapsed = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
const cost = (payload.usage && payload.usage.cost) || null;

const outDir = resolve(opts.outputDir);
mkdirSync(outDir, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
const base = join(outDir, `${slugify(opts.query || jobId)}-${stamp}`);
const record = {
  query: opts.query, preset: opts.preset, job_id: jobId,
  started_at: startedAt.toISOString(), elapsed_seconds: Number(elapsed),
  report, sources: sources(payload), usage: payload.usage || null,
  raw_output: payload.output || null,
};
writeFileSync(`${base}.json`, JSON.stringify(record, null, 2), 'utf8');
writeFileSync(`${base}.md`,
  `# ${opts.query || jobId}\n\n_preset: ${opts.preset} · ${elapsed}s · ${jobId || 'n/a'}_\n\n${report}\n`,
  'utf8');

const preview = opts.stdoutPreview === 0 ? report : report.slice(0, opts.stdoutPreview);
console.log(preview);
if (opts.stdoutPreview !== 0 && report.length > opts.stdoutPreview) {
  console.log(`\n… [${report.length - opts.stdoutPreview} more chars]`);
}
console.log(`\nsaved_to:\n  ${base}.md\n  ${base}.json`);
if (cost && cost.currency) {
  const total = Object.entries(cost)
    .filter(([k, v]) => typeof v === 'number' && k.endsWith('_cost') && !k.endsWith('_details'))
    .reduce((sum, [, v]) => sum + v, 0);
  console.log(`cost: ~${total.toFixed(4)} ${cost.currency}`);
}
