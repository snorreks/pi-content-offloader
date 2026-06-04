# pi-content-offloader

Auto-offloads large user inputs in [pi](https://pi.dev) to a temporary directory (`<tmpdir>/pi-offloads/`).

## Features

- **Explicit offload**: Type `$offload [name]` on its own line to designate content below it.
- **Auto-detect (Tier 2)** : Pasted content matching log/output patterns is automatically offloaded. Works even without the `$offload` tag — just paste a large block with a question after 2+ blank lines.
  - Soft threshold: `>2KB` with log/output patterns
  - Hard maximum: `>8KB` — always offloaded regardless of patterns
  - Disable with env var `PI_OFFLOADER_AUTO_DETECT=false` or `/offloader-toggle` at runtime
- **Smart previews**: Shows a concise summary (error first/last lines, build chunk stats, table rows) instead of the raw dump. Content is classified as: log output, stack trace, build output, config dump, table, or generic content.
- **Suffix extraction**: If a user question follows the pasted content (separated by 2+ blank lines), the question stays in the chat while the data is offloaded.
- **Deduplication**: Content hashes prevent duplicate offloads.
- **Auto-cleanup**: Files older than 7 days are removed automatically on session start.

## Install

```bash
pi install npm:pi-content-offloader
```

Or from a local path:

```bash
pi install ./extensions/content-offloader
```

## Usage

Paste a large block:

```
$offload build-logs

app.js     123.4 kB  gzip  45.2 kB
about.js    12.3 kB  gzip   4.1 kB
dashboard.js  89.0 kB  gzip  28.3 kB

Total: 3 chunks, 224 kB

Why is the dashboard chunk so large?
```

The content between `$offload` and your question is offloaded to a file. A summary replaces it in the chat.

You can also just paste a large block without the `$offload` marker — the extension auto-detects it:

```
[2026-06-04 14:32:01] ERROR: Connection timeout on /api/users
[2026-06-04 14:32:02] ERROR: Retry failed (1/3)
[2026-06-04 14:32:03] ERROR: Retry failed (2/3)
[2026-06-04 14:32:04] ERROR: Retry failed (3/3)
[2026-06-04 14:32:05] FATAL: Connection pool exhausted


Can you investigate this timeout issue?
```

Content matching log/output patterns (>2KB) or anything >8KB is offloaded automatically. The question after the blank lines stays in the chat.

## Development

```bash
bun install        # install dev dependencies
bun test           # run tests
bun typecheck      # type-check with tsc
bun lint           # lint with biome
```

## License

MIT
