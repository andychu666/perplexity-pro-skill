---
name: perplexity-pro
description: >
  Query Perplexity Pro for grounded AI answers with citations via Chrome CDP automation (pi-adapted).
  Use when (1) deep research with web citations needed, (2) questions where web_search
  is insufficient, (3) image generation requests, (4) complex multi-step research queries,
  (5) analyzing a specific URL, (6) continuing a conversation thread, (7) computer/tool-use tasks.
  (8) browsing the Discover news feed by category.
  Flags: --brief, --detailed, --chat, --url, --deep, --computer, --discover.
  Uses pi-managed Chrome browser (port 9222).
---

# Perplexity Pro (pi-adapted)

Query Perplexity Pro via Chrome CDP browser automation using pi's Chrome instance on port 9222.

## Prerequisites

- Chrome running with remote debugging on `:9222`
- Logged into Perplexity Pro account in Chrome (see [Login](#login-do-this-once-before-your-first-query))
- `puppeteer-core` available

## Setup

Run once before first use:

```bash
cd {baseDir} && npm install
```

If you already have the [browser-tools](https://github.com/badlogic/pi-skills/tree/main/browser-tools)
skill installed, the script will reuse its `puppeteer-core` automatically and you can skip `npm install`.

## Tests

Pure CLI/arg-parsing logic is covered by zero-dependency unit tests (Node's
built-in `node:test`). No browser required:

```bash
cd {baseDir} && npm test
```

## Quick Start

Start Chrome (if not running):
```bash
# Start headless Chrome
mkdir -p ~/.cache/browser-tools
google-chrome-stable \
  --remote-debugging-port=9222 \
  --user-data-dir=~/.cache/browser-tools \
  --no-first-run --no-default-browser-check \
  --no-sandbox --headless \
  2>/dev/null &

# Or with a visible display for login
# Omit --headless if you have X11/DISPLAY setup
```

## Login (do this once, before your first query)

Perplexity Pro answers require a logged-in session. **The login lives in the Chrome
profile on disk** (`~/.cache/browser-tools`), not in the running process — so you
log in once in a *visible* window and every later *headless* run reuses that
session automatically.

> ⚠️ One profile can only be opened by one Chrome at a time (a `SingletonLock` in
> the profile dir enforces this). Stop any headless Chrome on `:9222` before
> launching a visible one on the same `--user-data-dir`.

1. Stop any headless instance using the profile:
   ```bash
   pkill -f 'remote-debugging-port=9222'
   ```
2. Launch a **visible** Chrome on the same profile (needs a desktop / X display —
   note the **omitted** `--headless`):
   ```bash
   google-chrome-stable --remote-debugging-port=9222 \
     --user-data-dir=~/.cache/browser-tools \
     --no-first-run --no-default-browser-check
   ```
3. In that window go to <https://www.perplexity.ai>, sign in (Google SSO / email /
   magic link — whatever your Pro account uses), and confirm your account shows as
   logged in.
4. Close the window, then relaunch **headless** (the Quick Start command above).
   The session persists on disk; queries now run authenticated.

You only repeat this when the session eventually expires — symptom: logged-out or
Pro-gated answers (see the *Not logged in* item under [Troubleshooting](#troubleshooting)).
Don't try to log in *through* headless automation: Google SSO / magic-link flows
fight bot input (captcha, device checks). The visible-login → headless-reuse
pattern sidesteps all of it.

## Quick Query

```bash
node {baseDir}/scripts/perplexity-query.js "your question here"
```

## Flags

| Flag | Description | Combinable with |
|------|-------------|-----------------|
| `--brief` | Append "Answer briefly in 2-3 sentences" | `--chat`, `--deep`, `--url` |
| `--detailed` | Append "Provide a detailed, comprehensive answer" | `--chat`, `--deep`, `--computer`, `--url` |
| `--chat` | Continue in existing Perplexity thread (requires active `/search/` or `/thread/` tab) | `--brief`, `--detailed`, `--url` |
| `--url <URL>` | Prepend a URL for Perplexity to analyze (must be http/https) | All except conflicts |
| `--deep` | Enable Deep Research mode (extended timeout: 10 min) | `--brief`, `--detailed`, `--chat`, `--url` |
| `--computer` | Use Computer mode at `/computer/new` (extended timeout: 30 min) | `--detailed`, `--url` |
| `--discover [category]` | List Discover news headlines for a category (no query needed) | `--limit` |
| `--limit N` | Number of headlines per category for `--discover` (default: 10) | `--discover` |

### Discover Categories

`--discover` accepts: `top` (default), `tech`, `finance`, `arts`, `sports`, `entertainment`,
`for-you` (alias: `you`), or `all` (scrape every category). No login query is sent; it just
scrapes the Discover feed cards (title, url, published time, source count).

### Flag Conflicts (mutually exclusive)

- `--brief` + `--detailed` — contradictory instructions
- `--deep` + `--computer` — different Perplexity modes
- `--chat` + `--computer` — chat requires existing thread, computer starts fresh
- `--brief` + `--computer` — computer mode produces long-form output

## Examples

```bash
SKILL_DIR={baseDir}

# Standard query
node $SKILL_DIR/scripts/perplexity-query.js "What is quantum computing?"

# Brief answer
node $SKILL_DIR/scripts/perplexity-query.js --brief "Explain Docker containers"

# Detailed research
node $SKILL_DIR/scripts/perplexity-query.js --detailed "Compare React vs Vue in 2026"

# Analyze a URL
node $SKILL_DIR/scripts/perplexity-query.js --url https://example.com/article "Summarize this article"

# Deep Research (10 min timeout)
node $SKILL_DIR/scripts/perplexity-query.js --deep "History of semiconductor manufacturing"

# Computer mode (30 min timeout)
node $SKILL_DIR/scripts/perplexity-query.js --computer "Create a comparison table of top 5 cloud providers"

# Continue conversation in existing thread
node $SKILL_DIR/scripts/perplexity-query.js --chat "What about the security implications?"

# Deep Research with URL
node $SKILL_DIR/scripts/perplexity-query.js --deep --url https://arxiv.org/abs/1234.5678 "Analyze this paper"

# Discover: today's top headlines
node $SKILL_DIR/scripts/perplexity-query.js --discover top

# Discover: tech headlines, top 5
node $SKILL_DIR/scripts/perplexity-query.js --discover tech --limit 5

# Discover: your personalized feed
node $SKILL_DIR/scripts/perplexity-query.js --discover you

# Discover: every category at once
node $SKILL_DIR/scripts/perplexity-query.js --discover all --limit 10
```

## Discover Output JSON

```json
{
  "mode": "discover",
  "generatedAt": "2026-06-03T...",
  "categories": {
    "tech": [
      { "title": "...", "url": "https://www.perplexity.ai/discover/tech/...", "sources": 14, "published": "8 hours ago" }
    ]
  }
}
```

## Output JSON

```json
{
  "query": "...",
  "answer": "...",
  "mode": "standard|brief|detailed|chat|deep|computer",
  "isImageGeneration": false,
  "generatedImages": [{"path": "/tmp/perplexity-gen-1710000000000-0.png", "alt": "...", "width": 2848, "height": 1600}],
  "images": [],
  "sources": [{"title": "...", "url": "..."}],
  "screenshot": "/tmp/perplexity-result-1710000000000.png",
  "url": "https://www.perplexity.ai/search/..."
}
```

For image generation queries, `isImageGeneration` is `true` and images are auto-downloaded to `generatedImages[].path`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PERPLEXITY_TIMEOUT` | `120000` | Max wait for standard answer (ms) |
| `PERPLEXITY_DEEP_TIMEOUT` | `600000` | Max wait for Deep Research (ms) |
| `PERPLEXITY_COMPUTER_TIMEOUT` | `1800000` | Max wait for Computer mode (ms) |
| `PERPLEXITY_OUTPUT_DIR` | `/tmp` | Screenshot/image output directory |
| `PERPLEXITY_RETRIES` | `2` | Max retry attempts with exponential backoff |

## Differences from the OpenClaw Original

This is a port of an earlier Perplexity Pro skill (built for OpenClaw) to the pi / Claude Code skill format:

- Uses `puppeteer-core` instead of `playwright-core` (resolved from this skill's `node_modules`, or reused from the browser-tools skill)
- Connects to Chrome at `http://127.0.0.1:9222` instead of `:18800`
- No OpenClaw dependency
- Headless-friendly: Chrome started with `--headless` works (log into Perplexity at least once interactively first)
- Deep Research toggle rewritten for Perplexity's current Radix dropdown UI

## Prompting guide

**The query string is a research question, not a command.** Whatever you pass
becomes what Perplexity researches on the web, so be specific, state constraints,
and name the deliverable you want back:

- Good: `"Compare Postgres vs MySQL for write-heavy time-series workloads in 2026 — cover partitioning, compression, and ingestion throughput; give a table with tradeoffs"`
- Weak: `"postgres vs mysql"`

- Put the *output shape* in the prompt ("give a table", "list with tradeoffs", "cite sources for each claim").
- `--brief` for a single fact; `--detailed` / `--deep` when you want multi-source synthesis with citations.
- `--url <page>` grounds the answer in a specific source instead of the open web.
- Consume the JSON `answer` + `sources` fields programmatically — don't rely on the screenshot.

### Asking about Perplexity's *own* UI (Discover, library, threads) — scrape it, don't query it

Perplexity **cannot see its own Discover feed**. A text query like *"what's on
Perplexity Discover today?"* returns a generic web answer, not the real cards. To
get the actual feed you must read the **DOM** — use `--discover` (which does exactly
that), or drive the browser directly. Canonical agent prompt for a news digest:

> Use the browser tools to open https://www.perplexity.ai/discover, click the Top
> tab, and scrape the real story cards (headline + URL from the DOM — don't ask
> Perplexity as a text query, it can't see its own feed). Then write
> ~/Downloads/discover-news.md with each story as: ## Headline, a one-line summary,
> and a clickable link to its Perplexity URL.

The same rule applies to anything that is *UI state* rather than a researchable
question (your library, saved threads, account settings): **scrape the DOM, don't
ask Perplexity about itself.**

## Usage Guidelines

- Start with `web_search` for quick facts — escalate to Perplexity for depth
- Perplexity is best for: multi-source synthesis, current events, citation-heavy answers
- Use `--brief` for quick factual lookups, `--detailed` for research
- Use `--deep` for complex topics requiring extensive research
- Use `--computer` for tasks that need Perplexity's tool-use capabilities
- Use `--chat` to follow up on a previous query in the same thread
- Use `--url` to ask Perplexity to analyze a specific webpage

## Troubleshooting

- **"Could not connect to browser"**: Make sure Chrome is running on `:9222`. Check with `curl -s http://127.0.0.1:9222/json/version`.
- **"Could not find search input"**: Perplexity UI may have changed; check debug screenshot at `/tmp/perplexity-debug-*.png`.
- **Timeout with no answer**: Answer rendered but extraction failed; check result screenshot.
- **Not logged in**: You must log into Perplexity at least once. If running headless, start Chrome without `--headless` first, log in, then restart with `--headless` (the profile persists).
- **"--chat requires existing thread"**: Navigate to a Perplexity search page first, then use `--chat`.
- **Deep Research**: The mode selector is a Radix dropdown button (`aria-haspopup="menu"`) next to the search box. It only opens on a real pointer click, so the script uses a Puppeteer element-handle click, then selects the "Deep research" `menuitemradio`. The script verifies the mode actually switched and logs `Deep Research mode enabled` on success. If Perplexity changes the menu label/locale, update the text lists in `toggleDeepResearch()`.
