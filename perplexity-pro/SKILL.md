---
name: perplexity-pro
description: >
  Query Perplexity Pro for grounded AI answers with citations via Chrome CDP automation (pi-adapted).
  Use when (1) deep research with web citations needed, (2) questions where web_search
  is insufficient, (3) image generation requests, (4) complex multi-step research queries,
  (5) analyzing a specific URL, (6) continuing a conversation thread, (7) computer/tool-use tasks.
  (8) browsing the Discover news feed by category, (9) searching your own past
  threads (Library history) for prior research on a topic.
  Flags: --brief, --detailed, --chat, --url, --deep, --computer, --discover, --history.
  Uses pi-managed Chrome browser (port 9222).
---

# Perplexity Pro (pi-adapted)

Query Perplexity Pro via Chrome CDP browser automation using pi's Chrome instance on port 9222.

## Prerequisites

- Chrome running with remote debugging on `:9222`
- Logged into Perplexity Pro account in Chrome
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
| `--history "<term>"` | Search YOUR thread history (Library) for matching past threads | `--limit` |
| `--library "<term>"` | Alias for `--history` | `--limit` |
| `--limit N` | Max results for `--discover` / `--history` (default: 10) | `--discover`, `--history` |

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

# History: search your OWN past threads (Library) for prior research
node $SKILL_DIR/scripts/perplexity-query.js --history "whisper"

# History: alias + cap the number of results
node $SKILL_DIR/scripts/perplexity-query.js --library "dashcam transcription" --limit 5
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

## History Output JSON

```json
{
  "mode": "history",
  "query": "whisper",
  "count": 6,
  "threads": [
    { "type": "Search", "title": "ffmpeg filters to reduce Whisper hallucination on dashcam audio", "age": "2mo ago", "url": null }
  ],
  "screenshot": "/tmp/perplexity-history-1710000000000.png",
  "url": "https://www.perplexity.ai/library?q=whisper"
}
```

Notes:
- The Library search is **semantic/fuzzy** — a returned thread may not contain the
  literal search term (e.g. searching `ollama` also surfaces general local-LLM threads).
- `type` is the thread kind (`Search`, `Deep research`, `Computer`, …); `age` is the
  relative timestamp Perplexity shows.
- `url` is usually `null`: Library rows navigate via the in-app router, not `<a>`
  links, so a per-thread URL can't be scraped reliably. Use the title to locate the
  thread, or open `url` (the filtered Library view) in a browser.

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
