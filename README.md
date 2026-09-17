# perplexity-skill-for-openclaw

An **OpenClaw** skill for querying **Perplexity Pro** through Chrome DevTools Protocol
automation — grounded AI answers with citations, Deep Research, URL analysis, image
generation, conversation threads, and search over your own thread history (Library).

**Verified end-to-end only with OpenClaw.** The scripts are plain Node + `puppeteer-core`
and the folder follows the portable `SKILL.md` layout, so another harness may well load
it — but only the OpenClaw path has actually been exercised end to end (session reuse over
CDP, `--whoami`, history, discover, models, ask). Treat "works under pi / Claude Code /
Codex CLI / Amp / Droid" as **untested** until someone runs it there and reports back.

It drives the **OpenClaw-managed Chrome** (CDP on `:18800`; `PERPLEXITY_CDP` overrides).
This began as a port of the earlier OpenClaw skill into the pi-skills layout, which is why
the front matter still reads "pi-adapted" — the OpenClaw wiring is the tested one.

## Installation

The OpenClaw path is the verified one. The layouts below follow the portable
`SKILL.md` conventions and have **not** been exercised end to end — treat them as
untested starting points, not as supported installs.

### pi-coding-agent

```bash
# User-level (available in all projects)
git clone https://github.com/andychu666/perplexity-skill-for-openclaw ~/.pi/agent/skills/perplexity-skill-for-openclaw

# Or project-level
git clone https://github.com/andychu666/perplexity-skill-for-openclaw .pi/skills/perplexity-skill-for-openclaw
```

### Codex CLI

```bash
git clone https://github.com/andychu666/perplexity-skill-for-openclaw ~/.codex/skills/perplexity-skill-for-openclaw
```

### Claude Code

Claude Code only looks one level deep for `SKILL.md`, so symlink the skill folder:

```bash
git clone https://github.com/andychu666/perplexity-skill-for-openclaw ~/perplexity-skill-for-openclaw
mkdir -p ~/.claude/skills
ln -s ~/perplexity-skill-for-openclaw/perplexity-pro ~/.claude/skills/perplexity-pro
```

## Available Skills

| Skill | Description |
|-------|-------------|
| [perplexity-pro](perplexity-pro/SKILL.md) | Query Perplexity Pro for grounded answers with citations, Deep Research, and image generation |

## Skill Format

Each skill follows the pi / Claude Code format:

```markdown
---
name: skill-name
description: Short description shown to agent
---

# Instructions

Detailed instructions here...
Helper files available at: {baseDir}/
```

The `{baseDir}` placeholder is replaced with the skill's directory path at runtime.

## Requirements

- **Chrome** running with remote debugging on `:18800` (the OpenClaw-managed browser; `PERPLEXITY_CDP` overrides)
- A **Perplexity Pro** account, logged in within that Chrome profile
- **Node.js** — run `npm install` in `perplexity-pro/`, or reuse `puppeteer-core` from the
  [browser-tools](https://github.com/badlogic/pi-skills/tree/main/browser-tools) skill (auto-detected)

See [perplexity-pro/SKILL.md](perplexity-pro/SKILL.md) for full usage, flags, and troubleshooting.

## License

MIT
