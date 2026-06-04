# pi-content-offloader

Auto-offloads large user inputs in [pi](https://pi.dev) to `/tmp/pi-offloads/`.

## Features

- **Explicit offload**: Type `$offload [name]` on its own line to designate content below it.
- **Auto-detect**: Paste content >2KB with log/output patterns is automatically offloaded.
- **Smart previews**: Shows a concise preview (error summary, build stats, table rows) instead of the raw dump.
- **Suffix extraction**: If a user question follows the pasted content (separated by 2+ blank lines), the question stays in the chat while the data is offloaded.
- **Deduplication**: Content hashes prevent duplicate offloads.
- **Auto-cleanup**: Files older than 7 days are removed automatically.

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

## Development

```bash
bun install        # install dev dependencies
bun test           # run tests
bun typecheck      # type-check with tsc
bun lint           # lint with biome
```

## License

MIT
