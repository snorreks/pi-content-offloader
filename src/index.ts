/**
 * Auto-offloads large user inputs to <tmpdir>/pi-offloads/.
 *
 * Two-tier system:
 *   1. Explicit: `$offload [name]` marker to manually offload paste content
 *   2. Auto-detect: paste pattern matching + size thresholds (can be disabled)
 *
 * Auto-detect thresholds:
 *   >2KB + paste/output patterns → always offload with smart preview
 *   >8KB hard maximum → always offload
 *
 * Auto-detect also preserves suffix text after paste content (user's question),
 * separated by exactly 2 blank lines from the paste content.
 *
 * Smart previews: shows user's question/intent, not raw data dump.
 * Content types: build output, config dump, stack trace, table, task output.
 * Deduplicates by content hash. Auto-cleans files older than 7 days.
 *
 * Configuration:
 *   PI_OFFLOADER_AUTO_DETECT=false  — disable auto-detect (default: true)
 *   /offloader-toggle               — toggle auto-detect at runtime
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const HARD_MAX = 8000;
const PASTE_THRESHOLD = 2000;
const OFFLOAD_DIR = path.join(os.tmpdir(), 'pi-offloads');
const PREVIEW_LINES = 10;
const CLEANUP_DAYS = 7;
const DEDUP_SIZE = 200;
const EXPLICIT_MARKER = /^\$offload[^\n\r]*/m;

try {
  fs.mkdirSync(OFFLOAD_DIR, { recursive: true });
} catch (_) {}

// ── Recent hashes for deduplication ─────────────────────────────

const recentHashes = new Set<string>();

function contentHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
}

// ── Conversational detection ────────────────────────────────────

function isConversational(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return false;

  const proseRatio = lines.filter((l) => /^[A-Za-z]/.test(l.trim())).length / lines.length;
  const hasQuestions = (text.match(/\?/g) || []).length >= 1;
  const hasPronouns =
    /\b(I|we|my|our|you|your|can you|could you|please|thanks|let's|should)\b/i.test(text);
  const hasGreeting = /^(hey|hi|hello|ok|so|alright|good|sure|yeah|yes|no|sweet|nice)/im.test(text);
  const hasCodeBlocks = (text.match(/```/g) || []).length >= 2;
  const hasImperatives =
    /\b(try|check|make|add|fix|create|update|deploy|run|test|build|push|pull|merge|rebase)\b/i.test(
      text
    );

  return (
    proseRatio > 0.4 &&
    (hasQuestions || hasPronouns || hasGreeting || hasCodeBlocks || hasImperatives)
  );
}

// ── Explicit marker parsing ─────────────────────────────────────

interface OffloadResult {
  shouldOffload: boolean;
  content: string;
  prefix: string;
  beforeText: string;
  suffix: string;
  // Position tracking for inline replacement
  start: number;
  end: number;
}

function parseOffload(text: string): OffloadResult | null {
  const match = text.match(EXPLICIT_MARKER);
  if (!match) return null;

  // $offload matches at any position — text before it is preserved as prefix
  const markerStart = match.index as number;
  const beforeMarker = text.slice(0, markerStart).trim();
  const markerEnd = markerStart + match[0].length;
  let afterMarker = text.slice(markerEnd);

  // Skip any blank lines right after the marker
  const leadingGap = afterMarker.match(/^\n+/);
  if (leadingGap) {
    afterMarker = afterMarker.slice(leadingGap[0].length);
  }

  // Find the next $offload marker to scope this block's content boundary
  const nextOffload = afterMarker.match(EXPLICIT_MARKER);
  const contentArea = nextOffload ? afterMarker.slice(0, nextOffload.index as number) : afterMarker;

  // Find the separator between content and suffix within this block.
  // When another $offload follows: use FIRST separator (clear block boundary).
  // For a lone block: use LAST separator (handles multi-paragraph content).
  const re = /(\n\s*\n\s*)+/g;
  const separatorMatches = [...contentArea.matchAll(re)];

  // Select the right separator.
  // - For multiple blocks: explicit $offload boundary — all bounded content
  //   is offload payload; don't split on internal blank lines.
  // - For a lone block: walk backwards through separators, skipping any
  //   whose suffix looks like paste/log data. Only split when the suffix
  //   is conversational (a real user question). This prevents machine
  //   output with internal blank-line gaps from being half-offloaded.
  let separator: RegExpMatchArray | undefined;
  if (nextOffload) {
    // Explicit boundary from next $offload — pass through to the
    // "no separator" case below, which treats all contentArea as content.
    separator = undefined;
  } else {
    for (let i = separatorMatches.length - 1; i >= 0; i--) {
      const sep = separatorMatches[i];
      const sepEnd = (sep.index as number) + sep[0].length;
      const testSuffix = contentArea.slice(sepEnd).trim();
      // Only split here if the suffix looks like a real user question,
      // not more machine output that should be offloaded too.
      if (testSuffix && !isPaste(testSuffix)) {
        separator = sep;
        break;
      }
    }
  }

  if (!separator || separator.index === undefined) {
    // No blank line in this block — all contentArea is content
    const content = contentArea.trim();
    const gapSize = leadingGap ? leadingGap[0].length : 0;
    const contentStart = markerEnd + gapSize;
    // suffix is whatever comes after this block's content area
    const remaining = afterMarker.slice(contentArea.length).trim();
    return {
      shouldOffload: true,
      content: content || afterMarker.trim(),
      prefix: text.slice(markerStart, markerEnd).trim(),
      beforeText: beforeMarker,
      suffix: remaining,
      start: markerStart,
      end: contentStart + contentArea.length,
    };
  }

  const sepEnd = separator.index + separator[0].length;
  const pasteContent = contentArea.slice(0, separator.index).trim();
  // suffix = text after separator within this block + any remaining after this block
  const afterSep = contentArea.slice(sepEnd).trim();
  const remaining = afterMarker.slice(contentArea.length).trim();
  const suffix = [afterSep, remaining].filter(Boolean).join('\n\n');

  const gapSize = leadingGap ? leadingGap[0].length : 0;
  const contentStart = markerEnd + gapSize;
  const contentEnd = contentStart + separator.index + separator[0].length;

  return {
    shouldOffload: true,
    content: pasteContent,
    prefix: text.slice(markerStart, markerEnd).trim(),
    beforeText: beforeMarker,
    suffix,
    start: markerStart,
    end: contentEnd,
  };
}

function explicitName(marker: string): string | null {
  const match = marker.match(/^\$offload\s+(\S+)/);
  if (match?.[1]) return match[1];
  return null;
}

// ── Detection ────────────────────────────────────────────────────

function isPaste(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length > 100) return true;
  if (/[\u2500-\u257F┌┬┐├┼┤└┴┘│─]/.test(text)) return true;

  // Text starts with a shell prompt — strong CLI copy-paste signal
  if (isCliPaste(text)) return true;

  // CLI session: multiple prompt lines (commands + output)
  const promptLineCount = lines.filter((l) => isCliPaste(l)).length;
  if (promptLineCount >= 2) return true;

  const signals = [
    /\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/m, // ISO timestamps (bare or [bracketed])
    /^\s+at\s+.+\(.+:\d+:\d+\)/m, // Node.js stack frames: "    at fn (file.js:1:2)"
    /^\s*\S.*@\s+\S+\.\w+:\d+/m, // Browser stack frames: " (anonymous) @ file.js:946" or "Ec @ file.js:946"
    /^\S+\.(js|jsx|ts|tsx|mjs|cjs):\d+/m, // Browser console start: "file.js:123 message"
    /\.(js|jsx|ts|tsx|mjs|cjs):\d+$/m, // Browser console end: "message file.js:123"
    /\b(ERROR|FATAL|PANIC|CRITICAL)\b/i,
    /▮/,
    /\.(js|ts|css)\s+\d+\.\d+\s*kB.*gzip/m,
    /apiKey.*AIza/m, // Firebase config
    /serviceAccount|firebaseConfig/m,
    / on [\uE0A0\uE0A1\uE0A2\uE0B0\uE0B1\uE0B2\ue0a0\ue0a1\ue0a2\ue0b0\ue0b1\ue0b2▸❯▶→]/m, // Powerline git-branch glyph
    / on ☁️\s+\S+@\S+/m, // Cloud emoji + user@host
    /^\s*❯/m, // Shell prompt arrow lines
    /⚠/m, // Warning sign (firebase emulator, CLI tools)
    /^[i>⚠🟢🔴🟡🔵]\s{2,}\S/mu, // CLI log prefixes: "i  functions:", ">  log", "⚠  Multiple"
    /^\S+\s+(Running|Executing|Working directory|Starting|Seeded|Skipped|Cleared|Imported|Emulation seed):/m, // Script milestones
    /◇/m, // Diamond/lozenge symbol (dotenvx, CLI decoration)
  ];
  return signals.filter((p) => p.test(text)).length >= 1;
}

// ── CLI copy-paste detection ──────────────────────────────────

/** Detects text that starts with a shell prompt — someone copy-pasted from a terminal. */
function isCliPaste(text: string): boolean {
  return /^\s*[❯$#>➜]\s/.test(text);
}

/** Detects browser console output — lines matching `file.js:line` pattern. */
function isBrowserLog(text: string): boolean {
  return (
    /^\S+\.(js|jsx|ts|tsx|mjs|cjs):\d+/m.test(text) || /\.(js|jsx|ts|tsx|mjs|cjs):\d+$/m.test(text)
  );
}

function classify(text: string): string {
  // Stack traces: Node.js "at fn (file:1:2)" or browser "fn @ file.js:946"
  if (/^\s*at\s+.+\(.+:\d+:\d+\)/m.test(text)) return 'stack trace';
  if (/^\s+\S.*@\s+\S+\.\w+:\d+/m.test(text)) return 'stack trace';
  // Build output: chunk stats with kB
  if (/\.(js|ts|css)\s+\d+\.\d+\s*kB.*gzip/.test(text)) return 'build output';
  // Config dumps: Firebase / service account keys
  if (/(apiKey|firebaseConfig|serviceAccount|projectId).*AIza/m.test(text)) return 'config dump';
  // Task output markers
  if (/▮/.test(text)) return 'task output';
  // Box-drawing tables
  if (/[\u2500-\u257F┌┬┐├┼┤└┴┘│─]/.test(text)) return 'table';
  // Pipe tables
  if (/│\s+\S+\s+│/.test(text)) return 'table';
  // Log-like content: timestamps + error/fatal labels
  const hasTimestamp = /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/m.test(text);
  const hasErrorLabel = /\b(ERROR|FATAL|PANIC|CRITICAL|Uncaught)\b/i.test(text);
  if (hasTimestamp && hasErrorLabel) return 'log output';
  // Generic pasted content
  return 'content';
}

// ── Smart preview ───────────────────────────────────────────────

function cleanPreview(text: string): string {
  const lines = text.split('\n');

  // Build output → summarize chunk stats
  if (/\.(js|ts|css)\s+\d+\.\d+\s*kB.*gzip/.test(text)) {
    const chunkLines = lines.filter((l) => /\.(js|ts|css)\s+\d+\.\d+\s*kB.*gzip/.test(l));
    const totalKB = chunkLines.reduce((sum, l) => {
      const m = l.match(/(\d+\.\d+)\s*kB/);
      return sum + (m ? parseFloat(m[1]) : 0);
    }, 0);
    const headerLines = lines.filter(
      (l) => !/\.(js|ts|css)\s+\d+\.\d+\s*kB.*gzip/.test(l) && l.trim()
    );
    return [
      ...headerLines.slice(0, 3),
      `... ${chunkLines.length} files, ${totalKB.toFixed(0)} kB total`,
    ].join('\n');
  }

  // Error/stack trace → first + last error + frames
  const isNodeStack = /^\s*at\s+.+\(.+:\d+:\d+\)/m.test(text);
  const isBrowserStack = /^\s+\S.*@\s+\S+\.\w+:\d+/m.test(text);
  if (isNodeStack || isBrowserStack || /\b(ERROR|FATAL|PANIC|Uncaught)\b/.test(text)) {
    const errorLines = lines.filter((l) =>
      /\b(Error|Exception|Fatal|PANIC|Uncaught|Cannot|failed)\b/i.test(l)
    );
    const firstError = errorLines[0];
    const lastError = errorLines[errorLines.length - 1];
    const frames = lines
      .filter((l) => (isBrowserStack ? /^\s*\S.*@\s+\S+\.\w+:\d+/m.test(l) : /^\s*at\s+/.test(l)))
      .slice(0, 5);

    const result: string[] = [];
    if (firstError) result.push(firstError);
    if (lastError && lastError !== firstError) result.push(`... ${lastError}`);
    result.push(...frames);
    return result.join('\n');
  }

  // Config dump → show first config keys
  if (/(apiKey|firebaseConfig|serviceAccount)/.test(text)) {
    const configLines = lines
      .filter((l) => /\b(apiKey|projectId|authDomain|storageBucket)\b/.test(l))
      .slice(0, 5);
    return configLines.join('\n');
  }

  // Text with early paragraph break → show first paragraph (before any log dump)
  const firstEmpty = lines.findIndex((l) => !l.trim());
  if (firstEmpty > 0 && firstEmpty < 20) {
    return lines.slice(0, firstEmpty).join('\n');
  }

  // Task output → first N lines
  if (/▮/.test(text)) {
    return lines
      .filter((l) => l.trim())
      .slice(0, PREVIEW_LINES)
      .join('\n');
  }

  // Table → first N rows
  if (/[\u2500-\u257F┌┬┐├┼┤└┴┘│─]/.test(text) || /│/.test(text)) {
    return lines.slice(0, PREVIEW_LINES).join('\n');
  }

  // Default: first N non-empty lines
  return lines
    .filter((l) => l.trim())
    .slice(0, PREVIEW_LINES)
    .join('\n');
}

// ── Cleanup ─────────────────────────────────────────────────────

function cleanup() {
  try {
    const now = Date.now();
    const maxAge = CLEANUP_DAYS * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(OFFLOAD_DIR)) {
      const fp = path.join(OFFLOAD_DIR, f);
      if (now - fs.statSync(fp).mtimeMs > maxAge) {
        fs.unlinkSync(fp);
      }
    }
  } catch {}
}

// ── File writing ─────────────────────────────────────────────────

function writeLog(content: string, label?: string): { filepath: string; size: number } {
  const hash = contentHash(content);
  if (recentHashes.has(hash)) {
    // Dedup — return existing filepath if we can find it
    for (const f of fs.readdirSync(OFFLOAD_DIR)) {
      if (f.includes(hash)) {
        return { filepath: path.join(OFFLOAD_DIR, f), size: content.length };
      }
    }
  }

  recentHashes.add(hash);
  // Keep set bounded
  if (recentHashes.size > DEDUP_SIZE) {
    const toDelete = [...recentHashes].slice(0, recentHashes.size - DEDUP_SIZE);
    for (const h of toDelete) recentHashes.delete(h);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const namePart = label ? label.replace(/[^a-zA-Z0-9_.-]/g, '_') : 'offload';
  const filepath = path.join(OFFLOAD_DIR, `${namePart}-${hash}-${ts}.txt`);
  fs.writeFileSync(filepath, content, 'utf-8');
  return { filepath, size: content.length };
}

// ── Summary generation ──────────────────────────────────────────

function buildSummary(
  filepath: string,
  content: string,
  kind?: string,
  includePreview = true
): string {
  const kbSize = Math.round(content.length / 1024);
  const lineCount = content.split('\n').length;
  const kindLabel = kind || classify(content);

  const base = `📋 offloaded ${kindLabel} (${kbSize}KB, ${lineCount} lines) → read ${filepath}`;

  if (includePreview) {
    return `${base}\n\n${cleanPreview(content)}`;
  }
  return base;
}

// ── Multi-paste block detection ────────────────────────────────

/** Splits a paste input into multiple paste blocks + a conversational suffix.
 *  When two log/data blocks are separated by 2+ blank lines, each is offloaded
 *  separately so the user sees distinct summaries instead of one giant blob. */
function findAllPasteBlocks(text: string): { pasteBlocks: string[]; suffix: string } {
  const sepRe = /\n\s*\n\s*\n/g;
  const separators = [...text.matchAll(sepRe)];

  if (separators.length === 0) {
    return { pasteBlocks: [text], suffix: '' };
  }

  // Split text into blocks at each separator, trim each
  const blocks: string[] = [];
  let pos = 0;
  for (const sep of separators) {
    blocks.push(text.slice(pos, sep.index as number).trim());
    pos = (sep.index as number) + sep[0].length;
  }
  blocks.push(text.slice(pos).trim());

  const meaningful = blocks.filter(Boolean);
  if (meaningful.length === 0) return { pasteBlocks: [], suffix: '' };

  // Simple forward pass: each block is either paste (offload it) or
  // conversational (keep as suffix).
  const pasteBlocks: string[] = [];
  const suffixParts: string[] = [];

  for (const block of meaningful) {
    if (isPaste(block)) {
      pasteBlocks.push(block);
    } else {
      suffixParts.push(block);
    }
  }

  return { pasteBlocks, suffix: suffixParts.join('\n\n') };
}

// ── Paste boundary detection (single-block, legacy) ───────────

function findPasteBoundary(text: string): { pasteContent: string; suffix: string } {
  // Require exactly 2+ blank lines as separator — paste content can have
  // internal single blank lines without accidentally splitting the user's question.
  // Example:
  //   [ERROR] line 1
  //                    ← single blank line in paste → stays with content
  //   [ERROR] line 2
  //                    ← 2 blank lines → boundary
  //                    ← 2 blank lines → boundary (continued)
  //   Can you investigate?  ← this is the suffix
  // Use matchAll to find the last occurrence.
  const re = /\n\s*\n\s*\n(?=[\s\S]*\S{4,})/g;
  let lastMatch: RegExpMatchArray | null = null;
  for (const m of text.matchAll(re)) {
    lastMatch = m;
  }

  if (lastMatch && lastMatch.index !== undefined) {
    const sepEnd = lastMatch.index + lastMatch[0].length;
    const pasteContent = text.slice(0, lastMatch.index).trim();
    const suffix = text.slice(sepEnd).trim();

    // If suffix looks like more log/data output (not a user question),
    // merge it back into the paste so it all gets offloaded together.
    if (isPaste(suffix)) {
      return { pasteContent: text, suffix: '' };
    }

    // Tiny numeric/weird suffixes are also likely data
    if (suffix.length < 10 && !/[?]/.test(suffix) && !/^[A-Za-z]/.test(suffix)) {
      return { pasteContent: text, suffix: '' };
    }
    return { pasteContent, suffix };
  }
  return { pasteContent: text, suffix: '' };
}

// ── Extension ───────────────────────────────────────────────────

export default function offloader(pi: ExtensionAPI) {
  let autoDetect = process.env.PI_OFFLOADER_AUTO_DETECT?.toLowerCase() !== 'false';

  pi.on('session_start', (_event, ctx) => {
    cleanup();
    if (!autoDetect) {
      ctx.ui.setStatus('offloader', 'Auto-detect OFF');
    }
  });

  pi.registerCommand('offloader-toggle', {
    description: 'Toggle auto-detect on/off (Tier 2 paste detection)',
    handler: async (_args, ctx) => {
      autoDetect = !autoDetect;
      const state = autoDetect ? 'ON' : 'OFF';
      ctx.ui.notify(`Offloader auto-detect: ${state}`, 'info');
      if (!autoDetect) {
        ctx.ui.setStatus('offloader', 'Auto-detect OFF');
      } else {
        ctx.ui.setStatus('offloader', undefined);
      }
    },
  });

  pi.on('input', (event) => {
    if (event.source !== 'interactive') return;
    if (!event.text) return;

    const text = event.text;
    const len = text.length;

    // ── Tier 1: Explicit $offload marker ────────────────────
    // Process all $offload blocks one at a time, left to right
    let result = text;
    let safety = 0;
    while (safety++ < 20) {
      const parsed = parseOffload(result);
      if (!parsed) break;

      try {
        const name = explicitName(parsed.prefix);
        const { filepath } = writeLog(parsed.content, name);
        const summary = buildSummary(filepath, parsed.content, undefined, false);

        // Replace offload block inline: everything before + summary + everything after
        const after = result.slice(parsed.end);
        const spacer = after.trim() ? '\n\n' : '';
        result = result.slice(0, parsed.start) + summary + spacer + after.trim();
      } catch (_) {
        break;
      }
    }

    if (result !== text) {
      return { action: 'transform', text: result };
    }

    // ── Tier 2: Auto-detect (skip if disabled) ───────────────────
    if (!autoDetect) return;

    // Paste content >2KB → always offload (separate question with 2 blank lines)
    // CLI copy-paste (starts with ❯ / $ / # etc.): offload regardless of size
    // Non-paste content >8KB → offload
    const cliCopy = isCliPaste(text);
    const browserLog = isBrowserLog(text);
    if (isPaste(text)) {
      if (len <= PASTE_THRESHOLD && !cliCopy && !browserLog) return;
    } else {
      if (len <= HARD_MAX) return;
    }

    // Split into paste blocks + user's conversational suffix.
    // Multiple log blocks (e.g. two stack traces separated by 2 blank lines)
    // are combined into a single offload file instead of separate summaries.
    const { pasteBlocks, suffix } = findAllPasteBlocks(text);

    try {
      const parts: string[] = [];

      if (pasteBlocks.length === 1) {
        const { filepath } = writeLog(pasteBlocks[0]);
        parts.push(buildSummary(filepath, pasteBlocks[0], undefined, false));
      } else if (pasteBlocks.length > 1) {
        // Combine multiple paste blocks into one file with separators
        const combined = pasteBlocks.join('\n\n---\n\n');
        const { filepath } = writeLog(combined);
        const totalKb = Math.round(combined.length / 1024);
        const totalLines = combined.split('\n').length;
        const kindLabel = classify(combined);
        parts.push(
          `📋 offloaded ${pasteBlocks.length} ${kindLabel} blocks (${totalKb}KB, ${totalLines} lines) → read ${filepath}`
        );
      }

      if (suffix) {
        parts.push('');
        parts.push(suffix);
      }

      return { action: 'transform', text: parts.join('\n') };
    } catch (_) {
      return;
    }
  });
}

export {
  buildSummary,
  classify,
  cleanPreview,
  contentHash,
  explicitName,
  findAllPasteBlocks,
  findPasteBoundary,
  isBrowserLog,
  isCliPaste,
  isConversational,
  isPaste,
  offloader,
  parseOffload,
};
