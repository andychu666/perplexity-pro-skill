# Follow-ups

Tracked items from the GitNexus-assisted review of PR #1 (`--discover` mode).
Severe/correctness issues were fixed in the PR; the items below are deferred.

## Review summary (GitNexus)

- **Changed:** 2 files, 31 symbols, 1 execution flow (`Main → Sleep`)
- **Per-symbol blast radius:** `parseArgs`, `runDiscover`, `scrapeDiscoverCategory`, `main`
  all **LOW** risk — only `main` calls the new functions; no external callers, no
  breaking changes to existing query/answer flows.
- **Graph-level risk:** MEDIUM (inflated by the doc-heavy `SKILL.md` diff).

## Fixed in this PR

- **[SEVERE] Arg-parser swallowed peeked flags.** In the `--discover` / `--limit`
  handlers, `i++` advanced the index even when the next token was another flag
  (e.g. `--discover --limit 3`), so the following flag was skipped and its value
  leaked into positionals. Result: `--discover --limit 3` silently produced
  `limit: 10`. Fixed by peeking `argv[i + 1]` and only consuming `++i` when the
  token is a real value. Verified across reversed flags, aliases, and missing values.
- **[CLEANUP] Dead capture group.** `scrapeDiscoverCategory` passed an unused `cat`
  arg into `page.evaluate` and captured unused regex groups. Simplified to a
  boolean `RegExp.test` with no parameter.

## Deferred follow-ups

### 1. [MEDIUM] Discover DOM selectors are brittle
The scraper depends on Perplexity's current markup: `a[href*="/discover/"]`, first
`innerText` line as title, and `/(\d+)\s*sources?/i` / `Published` regexes for meta.
A UI redesign will silently return empty arrays.
- **Action:** add a `--debug` flag that screenshots `/discover/<cat>` and logs the
  matched card count, so failures are diagnosable. Consider a fallback selector set.

### 2. [LOW] `published` is free-text, not normalized
Values are scraped as-is: `"8 hours ago"`, `"Jun 2, 2026"`, `"13 minutes ago"`.
Downstream consumers can't sort/filter by recency reliably.
- **Action:** optionally parse relative/absolute strings into an ISO timestamp
  (`publishedAt`) while keeping the raw string.

### 3. [LOW] `--discover all` is sequential
Categories are scraped one-by-one in a single tab (~7 navigations). For `all` this
is the slowest path.
- **Action:** investigate scraping categories concurrently in separate tabs/pages,
  bounded by a small concurrency limit, then merge results.

### 4. [LOW] No de-dup across categories
The same story can appear in both `top` and `for-you` (observed: "Kremlin demands
Ukraine cede territory"). Each category de-dups internally but not globally.
- **Action:** for `all`, optionally annotate cross-category duplicates or expose a
  `--unique` flag.

### 5. [LOW] No automated tests — ✅ DONE
`parseArgs` had non-trivial flag-peeking logic that was the source of the severe
bug, with no test harness in the repo.
- **Resolved:** added `perplexity-pro/test/parseArgs.test.js` (Node built-in
  `node:test`, zero deps). 22 cases covering category default, aliases,
  lowercasing, `--limit` before/after `--discover`, the swallowed-flag regression,
  positional leakage, `--url` consumption, `buildQuery`/`getModeLabel`/
  `safeParseTimeout`, and all `process.exit(1)` validation paths (run via
  subprocess). The script now exports its pure helpers and guards `main()` with
  `require.main === module`; `puppeteer-core` loads lazily so the module can be
  required without Chrome. Run with `npm test`.

### 6. [INFO] GitNexus graph-risk vs. real risk
`detect-changes` reported MEDIUM largely because Markdown headings in `SKILL.md` are
indexed as "symbols." Per-function `impact` (LOW) is the accurate signal here.
- **Action:** none required — note for future reviews that doc-only churn can inflate
  the aggregate risk level.
