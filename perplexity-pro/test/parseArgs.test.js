#!/usr/bin/env node
/**
 * Unit tests for parseArgs and related pure helpers.
 *
 * Run: node --test perplexity-pro/test/   (Node >= 18)
 *   or: node perplexity-pro/test/parseArgs.test.js
 *
 * Pure-return cases require() the module directly. Cases that call
 * process.exit() (validation errors) are run in a subprocess so the
 * test runner doesn't get killed.
 */

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'perplexity-query.js');
const { parseArgs, buildQuery, getModeLabel, safeParseTimeout, DISCOVER_ALIASES } = require(SCRIPT);

// Run the CLI in a subprocess; return { code, stdout, stderr }.
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
    return { code: 0, stdout: (stdout || '').toString(), stderr: '' };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, stdout: (e.stdout || '').toString(), stderr: (e.stderr || '').toString() };
  }
}

test('parseArgs: bare query', () => {
  const { flags, query } = parseArgs(['What', 'is', 'TCP?']);
  assert.equal(query, 'What is TCP?');
  assert.equal(flags.discover, null);
  assert.equal(flags.limit, 10);
});

test('parseArgs: simple boolean flags', () => {
  const { flags } = parseArgs(['--brief', '--deep', 'hi']);
  assert.equal(flags.brief, true);
  assert.equal(flags.deep, true);
  assert.equal(flags.detailed, false);
});

test('parseArgs: --discover defaults to top', () => {
  const { flags } = parseArgs(['--discover']);
  assert.equal(flags.discover, 'top');
  assert.equal(flags.limit, 10);
});

test('parseArgs: --discover with explicit category', () => {
  const { flags } = parseArgs(['--discover', 'tech']);
  assert.equal(flags.discover, 'tech');
});

test('parseArgs: --discover applies aliases (you -> for-you)', () => {
  assert.equal(parseArgs(['--discover', 'you']).flags.discover, 'for-you');
  assert.equal(parseArgs(['--discover', 'foryou']).flags.discover, 'for-you');
  assert.equal(parseArgs(['--discover', 'FORME']).flags.discover, 'for-you');
});

test('parseArgs: category is lowercased', () => {
  assert.equal(parseArgs(['--discover', 'TECH']).flags.discover, 'tech');
});

// --- The regression that motivated follow-up #5 ---
test('parseArgs: --discover followed by --limit does NOT swallow the flag', () => {
  const { flags } = parseArgs(['--discover', '--limit', '3']);
  assert.equal(flags.discover, 'top', 'category should default to top');
  assert.equal(flags.limit, 3, 'limit must be 3, not the default 10 (regression)');
});

test('parseArgs: --limit before --discover (reversed order)', () => {
  const { flags } = parseArgs(['--limit', '7', '--discover', 'finance']);
  assert.equal(flags.discover, 'finance');
  assert.equal(flags.limit, 7);
});

test('parseArgs: --discover category then --limit', () => {
  const { flags } = parseArgs(['--discover', 'tech', '--limit', '5']);
  assert.equal(flags.discover, 'tech');
  assert.equal(flags.limit, 5);
});

test('parseArgs: --limit value is not treated as positional query', () => {
  const { flags, query } = parseArgs(['--discover', 'top', '--limit', '4']);
  assert.equal(flags.limit, 4);
  assert.equal(query, '', 'the limit value must not leak into positionals');
});

test('parseArgs: --url consumes exactly one value', () => {
  const { flags, query } = parseArgs(['--url', 'https://example.com', 'summarize', 'this']);
  assert.equal(flags.url, 'https://example.com');
  assert.equal(query, 'summarize this');
});

test('buildQuery: brief/detailed/url are single-line', () => {
  assert.ok(!buildQuery('q', { brief: true }).includes('\n'), 'brief must stay single-line');
  assert.ok(buildQuery('q', { brief: true }).includes('briefly'));
  assert.ok(buildQuery('q', { detailed: true }).includes('detailed'));
  assert.ok(buildQuery('q', { url: 'https://x.com' }).startsWith('https://x.com'));
});

test('getModeLabel: precedence', () => {
  assert.equal(getModeLabel({ computer: true, deep: true }), 'computer');
  assert.equal(getModeLabel({ deep: true }), 'deep');
  assert.equal(getModeLabel({ chat: true }), 'chat');
  assert.equal(getModeLabel({}), 'standard');
});

test('safeParseTimeout: invalid env falls back to default', () => {
  delete process.env.PPLX_TEST_TO;
  assert.equal(safeParseTimeout('PPLX_TEST_TO', 5000), 5000);
  process.env.PPLX_TEST_TO = 'notanumber';
  assert.equal(safeParseTimeout('PPLX_TEST_TO', 5000), 5000);
  process.env.PPLX_TEST_TO = '1234';
  assert.equal(safeParseTimeout('PPLX_TEST_TO', 5000), 1234);
  delete process.env.PPLX_TEST_TO;
});

test('DISCOVER_ALIASES maps friendly names', () => {
  assert.equal(DISCOVER_ALIASES.you, 'for-you');
});

// --- Validation errors that call process.exit(1) (run via subprocess) ---
test('CLI: --limit with missing value exits 1', () => {
  const r = runCli(['--discover', 'tech', '--limit']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--limit requires a positive integer/);
});

test('CLI: --limit 0 exits 1', () => {
  const r = runCli(['--discover', 'tech', '--limit', '0']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /positive integer/);
});

test('CLI: negative --limit exits 1', () => {
  const r = runCli(['--discover', 'tech', '--limit', '-5']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /positive integer/);
});

test('CLI: unknown discover category exits 1', () => {
  const r = runCli(['--discover', 'bogus']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown discover category/);
});

test('CLI: --url with no value exits 1', () => {
  const r = runCli(['--url']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--url requires a URL argument/);
});

test('CLI: --url with non-http scheme exits 1', () => {
  const r = runCli(['--url', 'ftp://example.com', 'hi']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /http or https/);
});

test('CLI: no query and no mode prints usage and exits 1', () => {
  const r = runCli([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage:/);
});

test('CLI: --help prints usage and exits 0', () => {
  const r = runCli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage:/);
});

test('CLI: -h prints usage and exits 0', () => {
  const r = runCli(['-h']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage:/);
});

test('CLI: unknown flag exits 1 and does not run query', () => {
  const r = runCli(['--bogus', 'hello']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown option "--bogus"/);
});

test('parseArgs: --help sets help flag without consuming query', () => {
  const { flags } = parseArgs(['--help', 'ignored']);
  assert.equal(flags.help, true);
});

test('parseArgs: `--` ends option parsing, rest is query text', () => {
  const { flags, query } = parseArgs(['--brief', '--', 'explain', 'the', '--verbose', 'flag']);
  assert.equal(flags.brief, true);
  assert.equal(query, 'explain the --verbose flag');
});

test('parseArgs: bare `--` yields empty query', () => {
  const { query } = parseArgs(['--']);
  assert.equal(query, '');
});

test('CLI: dash-prefixed query after `--` is accepted (exit != unknown-option)', () => {
  // Without `--` this would be rejected as an unknown option; with it, the only
  // reason to exit non-zero is the missing browser (Could not connect), never
  // an "unknown option" error. This proves the severe rejection is escapable.
  const r = runCli(['--', 'what', 'does', '--foo', 'mean']);
  assert.doesNotMatch(r.stderr, /unknown option/);
});

test('CLI: unknown flag is rejected before any network/browser call', () => {
  // An unknown option must fail fast with exit 1 and never attempt a connection
  // (no "Could not connect"/retry output, no Perplexity query).
  const r = runCli(['--nope', 'hello']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown option "--nope"/);
  assert.doesNotMatch(r.stderr, /Could not connect|Retry|Mode:/);
});
