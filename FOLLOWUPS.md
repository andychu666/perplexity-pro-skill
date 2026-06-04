# Follow-ups

Tracked items from the GitNexus-assisted reviews of the `--discover` mode (PR #1),
the `--help`/unknown-flag fix (PR #2), and the truncated-answer fix (PR #3).
Severe/correctness issues were fixed in the PRs; the items below are deferred.

---

## PR #3 — truncated-answer extraction in `waitForAnswer`

GitNexus-style review: `waitForAnswer` is **MEDIUM** risk. d=1 callers are
`runQuery`'s `--chat` branch and the standard/deep/computer branch; both destructure
`{ text, isImageGen }` and the return shape is unchanged, so no caller breakage. All
query execution flows (standard/brief/detailed/chat/deep/computer) run the changed
code; image-generation returns early and is unaffected.

### Fixed in PR #3

- **[SEVERE] Long / list-heavy answers were truncated to the first fragment.** The
  old streaming poll exited the first time two consecutive 1.5s polls matched, and
  extraction grabbed the *last* `[class*="prose"]` block. Long answers pause
  mid-stream while sources load, so polling stopped on item 1, and the last prose
  block is often a short trailing/related block. Result: "top 10 news" returned
  ~80 chars. Fixed by selecting the **longest** prose block and requiring multiple
  consecutive identical polls before accepting the text.
- **[SEVERE regression introduced then fixed in-PR] Completion gated on a fragile
  "still generating" heuristic pinned polling to the full timeout.** The first
  iteration required `!isGenerating()` before accepting a stable answer, and
  `isGenerating()` matched persistent skeleton loaders (`animate-pulse`) and any
  `stop`-labelled control — so it could return `true` forever, forcing the loop to
  run until `timeoutMs` (120s standard, 10min deep, 30min computer) even when the
  answer was ready in ~10s. Fixed by making the not-generating signal an
  *accelerant* only: accept on text stability alone (`STABLE_NO_HINT = 5` polls),
  and confirm faster when the UI reports not-generating (`STABLE_WITH_HINT = 2`).
  Dropped the `animate-pulse`/`loading`/`spinner` selectors from the hint to avoid
  false positives. Verified: short query returns in ~17s (not 120s); "top 10 news"
  returns the full ~2000-char list in ~18s.

### Deferred from PR #3

- **[MEDIUM] No automated test covers `waitForAnswer`.** It is pure DOM-timing
  logic that requires a live Perplexity page, so it is untested by the existing
  `node:test` suite. The two severe bugs both lived here.
  - **Action:** extract the stability state machine (poll → compare → stableCount
    → exit decision) into a pure, injectable function (text source + clock as
    params) so it can be unit-tested without Chrome. Add cases for: growing-then-
    stable text, never-stabilizes (timeout), and the not-generating accelerant.
- **[LOW] `extractText` longest-block heuristic could pick a non-answer block.** If
  Perplexity ever renders a related/sources block longer than the answer body, the
  "longest prose block" rule would select the wrong element.
  - **Action:** prefer a block scoped to the answer container (e.g. nearest ancestor
    matching an answer/thread test-id) before falling back to longest-overall.
- **[LOW] `isGenerating` `stop` label is locale-dependent.** The check matches the
  English substring `"stop"`; in other Perplexity locales the accelerant simply
  won't fire (falls back to `STABLE_NO_HINT`), so it's safe but slower.
  - **Action:** none required; revisit if non-English usage becomes common.
- **[INFO] Trailing citation noise in answers.** Extracted text still contains
  inline source markers like `bbc\n+1`. Pre-existing behaviour, not introduced by
  this PR.
  - **Action:** optionally strip standalone `\n<source>\n+N` lines in a post-process
    step, keyed off the already-extracted `sources` array.

## PR #2 — `--help` / unknown-flag handling

GitNexus review: `parseArgs` and `main` both **LOW** risk (only the test file and
the CLI entrypoint are upstream callers; no external/production consumers). Aggregate
risk reported MEDIUM only because `main` participates in indexed execution flows.

### Fixed in PR #2

- **[SEVERE] Unknown/`--help` flags were sent to Perplexity as query text.** The
  arg-parser `default:` case treated any unrecognized token as part of the query,
  so `--help` (and typos like `--breif`) were submitted as prompts. Fixed by
  rejecting tokens matching `--xxx` / `-x` with exit 1, and handling `-h`/`--help`
  (prints usage, exits 0 before any browser/network call).
- **[SEVERE follow-on] Legitimate queries containing dash-prefixed words were
  wrongly rejected.** Once unknown flags were rejected, an unquoted query such as
  `explain the --verbose flag` would error. Fixed with a POSIX `--` end-of-options
  separator: everything after `--` is treated as query text verbatim. Documented in
  `HELP_TEXT` and the unknown-option error message.
- **[TEST] Unknown flag must not reach the network.** Added an explicit test
  asserting an unknown option exits 1 with no `Could not connect`/retry/`Mode:`
  output, plus tests for the `--` separator and help-on-stdout. Suite now 30 cases
  (was 22).

### Deferred from PR #2

- **[LOW] Lone `-` and negative-number tokens.** `/^-[a-zA-Z]/` does not match a
  bare `-` (treated as query text) nor negative numbers like `-5` (also query
  text, since they don't start with a letter). Both are harmless in practice and
  the `--` separator covers any intentional dash-prefixed query. No action unless
  a real use case appears.

---

## PR #1 — `--discover` mode

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

---

## PR #5 — `--history` / `--library` thread-history search

GitNexus-assisted review. `impact` on the new symbols (`runHistory`,
`parseHistoryRows`, `parseHistoryRowText`, `libraryShellPresent`) is **LOW**: 0
upstream dependents, 0 of the 6 existing execution flows affected — the feature is
purely additive (only `parseArgs`/`main`/exports gained branches, covered by tests).

### Fixed in PR #5

- **[SEVERE] Silent false-negative when the Library didn't render.** `runHistory`
  returned `count: 0` with empty `threads` whenever the Library panel failed to load
  (expired session → login redirect, slow load). That is indistinguishable from a
  genuine "no matches" and would wrongly imply no prior research exists — the exact
  false-negative class that misled the very review that produced this feature. Fixed
  by adding `libraryShellPresent()` (detects the signed-in Library chrome): the
  manual overlay fallback now fires only when the shell is **absent** (not on a
  genuine zero-match), and if the shell is still absent the function **throws** a
  clear "are you signed in?" error instead of returning empty. Also removes a wasted
  ~3.4s overlay fallback on every genuine zero-match. Covered by new
  `libraryShellPresent` unit tests (`npm test` → 40 cases).

### Deferred (filed as issues)

1. **[LOW] Title equal to a row-type word can be misparsed** (#6). A thread whose
   title is exactly `Search`/`Page`/`Computer`/… is treated as a row delimiter by
   `parseHistoryRows`. Low probability; harden by requiring an `… ago` line to close
   the group, or anchor on row container structure.
2. **[LOW] Age regex misses `just now` / localized timestamps** (#7).
   `HISTORY_AGE_RE` only matches `<N><unit> ago`; other forms could leak in as a
   title candidate. Add `just now|now` and locale forms (cf. the Chinese fallbacks in
   `toggleDeepResearch`).
3. **[LOW] Reuses/navigates an existing Perplexity tab** (#8). `runHistory` navigates
   the first `perplexity.ai` tab to `library?q=...`, interrupting an open thread.
   Shared with `--discover`/standard query, so a pattern-wide concern rather than new.

### Known limitation (documented, not a bug)

- `threads[].url` is usually `null`: Library result rows navigate via the in-app
  router, not `<a>` tags, so per-thread URLs can't be scraped reliably. The
  top-level `url` returns the filtered Library view (`library?q=<term>`). Library
  search is also **semantic/fuzzy** — a hit need not contain the literal term. Both
  are noted in `SKILL.md`.
