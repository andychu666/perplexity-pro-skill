# perplexity-pro-skill

A [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) skill
for querying **Perplexity Pro** through Chrome DevTools Protocol automation — grounded AI answers
with citations, Deep Research, URL analysis, image generation, and conversation threads.

Compatible with pi, Claude Code, Codex CLI, Amp, and Droid.

This is a port of an earlier Perplexity Pro skill (originally built for OpenClaw) to the
[badlogic/pi-skills](https://github.com/badlogic/pi-skills) format, using `puppeteer-core`
and Chrome on port `9222`.

## Installation

### pi-coding-agent

```bash
# User-level (available in all projects)
git clone https://github.com/andychu666/perplexity-pro-skill ~/.pi/agent/skills/perplexity-pro-skill

# Or project-level
git clone https://github.com/andychu666/perplexity-pro-skill .pi/skills/perplexity-pro-skill
```

### Codex CLI

```bash
git clone https://github.com/andychu666/perplexity-pro-skill ~/.codex/skills/perplexity-pro-skill
```

### Claude Code

Claude Code only looks one level deep for `SKILL.md`, so symlink the skill folder:

```bash
git clone https://github.com/andychu666/perplexity-pro-skill ~/perplexity-pro-skill
mkdir -p ~/.claude/skills
ln -s ~/perplexity-pro-skill/perplexity-pro ~/.claude/skills/perplexity-pro
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

- **Chrome** running with remote debugging on `:9222`
- A **Perplexity Pro** account, logged in within that Chrome profile
- **Node.js** — run `npm install` in `perplexity-pro/`, or reuse `puppeteer-core` from the
  [browser-tools](https://github.com/badlogic/pi-skills/tree/main/browser-tools) skill (auto-detected)

See [perplexity-pro/SKILL.md](perplexity-pro/SKILL.md) for full usage, flags, and troubleshooting.

## License

MIT
