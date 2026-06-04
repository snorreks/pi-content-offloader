/**
 * Tests for offloader extension.
 *
 * Tests the core logic functions (no pi ExtensionAPI mock needed):
 * - isConversational() — conversational detection
 * - parseOffload() — explicit $offload marker parsing
 * - isPaste() — paste pattern detection
 * - classify() — content type classification
 * - cleanPreview() — smart preview generation
 *
 * NOTE: This tests the PURE FUNCTIONS only. The pi.on("input") event handler
 * is tested manually via /reload + pasting content.
 *
 * Run: bun test
 */

import { describe, expect, it } from 'bun:test';
import {
  buildSummary,
  classify,
  cleanPreview,
  contentHash,
  explicitName,
  findPasteBoundary,
  isConversational,
  isPaste,
  parseOffload,
} from '../src/index.ts';

// ═══════════════════════════════════════════════════════════════
// isConversational()
// ═══════════════════════════════════════════════════════════════

describe('isConversational', () => {
  it('detects questions as conversational', () => {
    expect(isConversational('Can you fix the deployment? It keeps failing.')).toBe(true);
  });

  it('detects greetings as conversational', () => {
    expect(isConversational('Hey, can you look at this error?')).toBe(true);
    expect(isConversational('Hi there, I need help with the build.')).toBe(true);
  });

  it('detects pronouns + imperatives as conversational', () => {
    expect(isConversational('I need you to add logging to the webhook handler.')).toBe(true);
    expect(isConversational("Let's create a test for this function.")).toBe(true);
  });

  it('detects code blocks with prose as conversational', () => {
    const msg = [
      'Here is the function that fails:',
      '',
      '```ts',
      'function foo() {',
      "  throw new Error('bad')",
      '}',
      '```',
      '',
      'Can you fix it?',
    ].join('\n');
    expect(isConversational(msg)).toBe(true);
  });

  it('returns false for pure paste content', () => {
    const paste = [
      '[2026-05-26 14:32:01] ERROR: Connection timeout',
      '[2026-05-26 14:32:02] ERROR: Retry failed (1/3)',
      '[2026-05-26 14:32:03] ERROR: Retry failed (2/3)',
      '[2026-05-26 14:32:04] ERROR: Retry failed (3/3)',
      '[2026-05-26 14:32:05] FATAL: Connection pool exhausted',
    ].join('\n');
    expect(isConversational(paste)).toBe(false);
  });

  it('returns false for stack traces', () => {
    const trace = [
      'Error: something broke',
      '    at Module.foo (/app/src/bar.ts:42:5)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n');
    expect(isConversational(trace)).toBe(false);
  });

  it('returns false for build output', () => {
    const build = [
      'Route (app)                              Size     First Load JS',
      '┌ ○ /                                    5.1 kB         89 kB',
      '├ ○ /api                                 2.3 kB         82 kB',
      '└ ○ /dashboard                           3.7 kB         91 kB',
    ].join('\n');
    expect(isConversational(build)).toBe(false);
  });

  it('detects mixed prose + data as conversational', () => {
    const msg = [
      "Here's the error log from production:",
      '',
      'ERROR 2026-05-26 ERR_TIMEOUT',
      'ERROR 2026-05-26 ERR_TIMEOUT',
      '',
      'What should I do about this?',
    ].join('\n');
    // Has pronouns, question, prose ratio is good
    expect(isConversational(msg)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// parseOffload()
// ═══════════════════════════════════════════════════════════════

describe('parseOffload', () => {
  it('detects $offload marker with named content', () => {
    const input = [
      '$offload prod-errors',
      '',
      '[ERROR] Timeout on /api/users',
      '[FATAL] Connection pool exhausted',
      '',
      'Can you investigate?',
    ].join('\n');

    const result = parseOffload(input);
    expect(result).not.toBeNull();
    expect(result?.shouldOffload).toBe(true);
    expect(result?.content).toBe(
      '[ERROR] Timeout on /api/users\n[FATAL] Connection pool exhausted'
    );
    expect(result?.suffix).toBe('Can you investigate?');
  });

  it('detects $offload marker without name', () => {
    const input = ['$offload', '', 'Some paste content here'].join('\n');

    const result = parseOffload(input);
    expect(result).not.toBeNull();
    expect(result?.shouldOffload).toBe(true);
    expect(result?.content).toBe('Some paste content here');
    expect(result?.suffix).toBe('');
  });

  it('handles $offload with content but no suffix', () => {
    const input = ['$offload logs', '', 'Error line 1', 'Error line 2'].join('\n');

    const result = parseOffload(input);
    expect(result).not.toBeNull();
    expect(result?.content).toBe('Error line 1\nError line 2');
    expect(result?.suffix).toBe('');
  });

  it('returns null when no $offload marker present', () => {
    const input = 'This is just a regular message with no marker';
    expect(parseOffload(input)).toBeNull();
  });

  it('detects $offload mid-text when on its own line', () => {
    const input = 'Some text before\n\n$offload\n\nPasted content here';
    const result = parseOffload(input);
    expect(result).not.toBeNull();
    expect(result?.content).toBe('Pasted content here');
    expect(result?.beforeText).toBe('Some text before');
    expect(result?.suffix).toBe('');
  });

  it('handles $offload with no blank line — treats all remaining as content', () => {
    const input = '$offload\nError line 1\nError line 2';
    const result = parseOffload(input);
    expect(result).not.toBeNull();
    expect(result?.content).toBe('Error line 1\nError line 2');
    expect(result?.suffix).toBe('');
  });

  it('preserves suffix text after double newline', () => {
    const input = [
      '$offload backend-logs',
      '',
      '[ERROR] Timeout',
      '[ERROR] Retry failed',
      '',
      'Please check the timeout config',
      'And look at the retry policy too',
    ].join('\n');

    const result = parseOffload(input);
    expect(result).not.toBeNull();
    expect(result?.content).toBe('[ERROR] Timeout\n[ERROR] Retry failed');
    expect(result?.suffix).toBe(
      'Please check the timeout config\nAnd look at the retry policy too'
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// isPaste()
// ═══════════════════════════════════════════════════════════════

describe('isPaste', () => {
  it('detects stack traces as paste', () => {
    const trace = 'Error: failed\n    at foo (bar.ts:1:2)';
    expect(isPaste(trace)).toBe(true);
  });

  it('detects error logs as paste', () => {
    const log = '2026-05-26 14:32:01 ERROR: Connection timeout';
    expect(isPaste(log)).toBe(true);
  });

  it('detects build output as paste', () => {
    const build = 'app.js  123.4 kB  gzip  45.2 kB';
    expect(isPaste(build)).toBe(true);
  });

  it('detects config dumps as paste', () => {
    expect(isPaste('apiKey AIza...\nprojectId foo')).toBe(true);
    expect(isPaste('firebaseConfig = {...}')).toBe(true);
  });

  it('detects box-drawing tables as paste', () => {
    expect(isPaste('┌──┬──┐\n│ a│ b│\n└──┴──┘')).toBe(true);
  });

  it('detects Starship/powerline shell prompts as paste', () => {
    expect(isPaste('nordclaw on \uE0A0 master via 🥟 v1.3.13 on ☁️  snorre@mailvideo.com')).toBe(
      true
    );
    expect(isPaste('project on \uE0A0 main')).toBe(true);
    expect(isPaste('app on ☁️  user@host.com')).toBe(true);
  });

  it('detects shell prompt arrows (❯) as paste', () => {
    expect(isPaste('❯ npm run build\n❯ node server.js')).toBe(true);
    expect(isPaste('  ❯ something went wrong')).toBe(true);
  });

  it('returns false for short conversational text', () => {
    expect(isPaste('Hey, can you fix this?')).toBe(false);
    expect(isPaste('I need help with deployment')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// classify()
// ═══════════════════════════════════════════════════════════════

describe('classify', () => {
  it('classifies log output with timestamps + error labels', () => {
    expect(
      classify(
        '[2026-05-26 14:32:01] ERROR: Connection timeout\n[2026-05-26 14:32:02] ERROR: Retry failed'
      )
    ).toBe('log output');
    expect(classify('[2026-05-26T14:32:01] FATAL: Out of memory\nProcess exited')).toBe(
      'log output'
    );
  });

  it("does NOT classify random text with 'Cannot'/'failed' as log output", () => {
    // Words like Cannot/failed appear in normal prompts — must have timestamps too
    expect(classify('I cannot get this to work\nThe build failed again')).toBe('content');
    expect(classify('Please help: deployment failed\nCannot connect to API')).toBe('content');
  });

  it('classifies stack traces', () => {
    expect(classify('    at foo (bar.ts:1:2)\n    at baz (qux.ts:3:4)')).toBe('stack trace');
  });

  it('classifies build output', () => {
    expect(classify('app.js  12.3 kB  gzip  4.5 kB')).toBe('build output');
  });

  it('classifies config dumps', () => {
    expect(classify('apiKey: AIza...\nprojectId: myapp')).toBe('config dump');
  });

  it('classifies box-drawing tables', () => {
    expect(classify('┌──┐\n│ a│\n└──┘')).toBe('table');
  });

  it('classifies pipe tables', () => {
    expect(classify('│ name │ value │\n│ foo  │ 42    │')).toBe('table');
  });

  it("defaults to 'content' for unrecognized text", () => {
    expect(classify('Just some plain text')).toBe('content');
  });
});

// ═══════════════════════════════════════════════════════════════
// cleanPreview()
// ═══════════════════════════════════════════════════════════════

describe('cleanPreview', () => {
  it('generates build output preview with KB total', () => {
    const build = [
      'Route (app)',
      'app.js     12.3 kB  gzip  4.5 kB',
      'about.js   8.7 kB   gzip  3.2 kB',
      'dashboard.js   15.1 kB  gzip  5.9 kB',
    ].join('\n');

    const preview = cleanPreview(build);
    expect(preview).toContain('Route (app)');
    expect(preview).toContain('3 files');
    expect(preview).toContain('36 kB total');
  });

  it('extracts error + first and last error lines', () => {
    const trace = [
      'Error: Connection timeout on /api/users',
      '    at fetchUsers (users.ts:42:5)',
      '    at processRequest (server.ts:100:3)',
      '    at handle (router.ts:55:1)',
      '    at runMicrotasks (<anonymous>)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
      'WARN: RetryPolicy: Exhausted 3 attempts',
      'FATAL: Cannot recover — shutting down',
    ].join('\n');

    const preview = cleanPreview(trace);
    expect(preview).toContain('Error: Connection timeout');
    expect(preview).toContain('FATAL: Cannot recover');
    expect(preview).toContain('at fetchUsers');
  });

  it('generates config dump preview', () => {
    const config = [
      'firebaseConfig = {',
      '  apiKey: "AIza...xyz",',
      '  authDomain: "app.firebaseapp.com",',
      '  projectId: "my-project",',
      '}',
    ].join('\n');

    const preview = cleanPreview(config);
    expect(preview).toContain('apiKey');
    expect(preview).toContain('projectId');
  });

  it('shows first paragraph for text with early blank line', () => {
    const text = [
      'Building the project...',
      '',
      'Route (app)                              Size',
      '┌ ○ /                                    5.1 kB',
    ].join('\n');

    const preview = cleanPreview(text);
    expect(preview).toBe('Building the project...');
    expect(preview).not.toContain('Route');
  });

  it('shows first N lines for unclassified text', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
    const text = lines.join('\n');

    const preview = cleanPreview(text);
    const previewLines = preview.split('\n');
    expect(previewLines.length).toBeLessThanOrEqual(10);
  });
});

// ═══════════════════════════════════════════════════════════════
// findPasteBoundary()
// ═══════════════════════════════════════════════════════════════

describe('findPasteBoundary', () => {
  it('returns entire text as paste when no separator found', () => {
    const text = 'Just some error log content\nWith multiple lines\nBut no question';
    const result = findPasteBoundary(text);
    expect(result.pasteContent).toBe(text);
    expect(result.suffix).toBe('');
  });

  it('splits paste and question at last double blank line', () => {
    const text = [
      'ERROR: Connection timeout',
      'ERROR: Retry failed',
      'ERROR: Pool exhausted',
      '',
      '',
      'Can you investigate this issue?',
    ].join('\n');

    const result = findPasteBoundary(text);
    expect(result.pasteContent).toBe(
      'ERROR: Connection timeout\nERROR: Retry failed\nERROR: Pool exhausted'
    );
    expect(result.suffix).toBe('Can you investigate this issue?');
  });

  it('preserves multi-line suffix', () => {
    const text = [
      'FATAL: Out of memory',
      'FATAL: Process killed',
      '',
      '',
      'I think this is related to the memory leak we discussed.',
      'Can you look at the heap dump too?',
    ].join('\n');

    const result = findPasteBoundary(text);
    expect(result.pasteContent).toBe('FATAL: Out of memory\nFATAL: Process killed');
    expect(result.suffix).toContain('memory leak');
    expect(result.suffix).toContain('heap dump');
  });

  it('treats short non-question suffix as part of paste', () => {
    const text = [
      'ERROR: Timeout',
      'ERROR: Retry',
      '',
      '',
      '123', // short, no question mark, doesn't start with letter
    ].join('\n');

    const result = findPasteBoundary(text);
    // Short numeric suffix should be treated as data, not a question
    expect(result.pasteContent).toBe(text);
    expect(result.suffix).toBe('');
  });

  it('keeps short suffix if it starts with a letter', () => {
    const text = [
      'ERROR: Crash',
      '',
      '',
      'Why?', // starts with letter
    ].join('\n');

    const result = findPasteBoundary(text);
    expect(result.pasteContent).toBe('ERROR: Crash');
    expect(result.suffix).toBe('Why?');
  });

  it('uses last separator when multiple exist', () => {
    const text = [
      'Step 1: Build',
      'Output line 1',
      '',
      '',
      'Step 2: Test',
      'Output line 2',
      '',
      '',
      'What does the test failure mean?',
    ].join('\n');

    const result = findPasteBoundary(text);
    expect(result.pasteContent).toContain('Step 1: Build');
    expect(result.pasteContent).toContain('Step 2: Test');
    expect(result.suffix).toBe('What does the test failure mean?');
  });

  it('handles no suffix — all paste', () => {
    const text = ['ERROR: Crash', 'ERROR: Burn', '', ''].join('\n');

    const result = findPasteBoundary(text);
    // No meaningful text after the last double blank -> all is paste
    expect(result.suffix).toBe('');
    // pasteContent is the full original text (not trimmed, since no boundary found)
    expect(result.pasteContent).toBe(text);
  });

  it('does NOT split on single blank line — requires 2+ blank lines', () => {
    // Paste content with internal single blank line (e.g., multi-paragraph logs)
    // and a question after — but only 1 blank line separator
    const text = [
      'ERROR: Connection timeout',
      '',
      'ERROR: Retry failed',
      '',
      'Can you investigate?',
    ].join('\n');

    const result = findPasteBoundary(text);
    // Single blank line is not a boundary — everything is paste content
    expect(result.pasteContent).toBe(text);
    expect(result.suffix).toBe('');
  });

  it('splits correctly with 2 blank lines when content has internal blanks', () => {
    const text = ['ERROR: Timeout', '', 'ERROR: Retry', '', '', 'Hey, can you fix this?'].join(
      '\n'
    );

    const result = findPasteBoundary(text);
    // Content = everything before the 2-blank-line separator
    expect(result.pasteContent).toBe('ERROR: Timeout\n\nERROR: Retry');
    expect(result.suffix).toBe('Hey, can you fix this?');
  });

  it('merges suffix back into paste when suffix looks like more log data', () => {
    // Simulates: router logs → 2 blank lines → firebase error JSON
    // The suffix is more machine output, not a user question
    const text = [
      '15:02 [RouterService] goToRoute',
      'XHRPOST https://example.com/api?key=xxx',
      '[HTTP/3 403  57ms]',
      '',
      '',
      '[2026-05-29T13:02:55.885Z] @firebase/data-connect: Error: PERMISSION_DENIED',
      '{"error":{"code":403,"message":"Permission denied"}}',
    ].join('\n');

    const result = findPasteBoundary(text);
    // Suffix has ISO timestamp → isPaste(suffix)=true → merged back into paste
    expect(result.pasteContent).toBe(text);
    expect(result.suffix).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════
// parseOffload edge cases (post-$ prefix change)
// ═══════════════════════════════════════════════════════════════

describe('parseOffload edge cases', () => {
  it('rejects $offload preceded by whitespace on the same line', () => {
    const input = '   $offload logs\n\nError content';
    // With m flag, ^ matches at position 0, then spaces don't match $offload
    // So the regex won't match at all
    expect(parseOffload(input)).toBeNull();
  });

  it('accepts $offload preceded by a leading newline', () => {
    const input = '\n$offload logs\n\nError content';
    const result = parseOffload(input);
    expect(result).not.toBeNull();
    expect(result?.content).toBe('Error content');
  });

  it('preserves text before marker separately from suffix', () => {
    const input = [
      'bla bla bla',
      '',
      '$offload',
      'test',
      'test2',
      'test3',
      '',
      '',
      'how about this?',
    ].join('\n');

    const result = parseOffload(input);
    expect(result).not.toBeNull();
    expect(result?.content).toBe('test\ntest2\ntest3');
    expect(result?.beforeText).toBe('bla bla bla');
    expect(result?.suffix).toBe('how about this?');
  });

  it('handles $offload with extra spaces between name and content', () => {
    const input = [
      '$offload my-logs',
      '',
      '',
      '[ERROR] Something went wrong',
      '[FATAL] Cannot recover',
      '',
      'Please investigate',
    ].join('\n');

    const result = parseOffload(input);
    expect(result).not.toBeNull();
    expect(result?.content).toBe('[ERROR] Something went wrong\n[FATAL] Cannot recover');
    expect(result?.suffix).toBe('Please investigate');
  });

  it('strips only first blank line gap after marker', () => {
    // Marker line -> blank skip -> content -> blank -> suffix
    const input = ['$offload', '', 'Line 1', 'Line 2', '', 'What now?'].join('\n');

    const result = parseOffload(input);
    expect(result).not.toBeNull();
    expect(result?.content).toBe('Line 1\nLine 2');
    expect(result?.suffix).toBe('What now?');
  });

  it('uses LAST separator when content itself has internal blank lines', () => {
    const input = [
      '$offload test',
      '',
      'Paragraph one of pasted content.',
      '',
      'Paragraph two — more pasted stuff.',
      '',
      'Paragraph three of the paste.',
      '',
      '',
      'Now my actual question?',
    ].join('\n');

    const result = parseOffload(input);
    expect(result).not.toBeNull();
    expect(result?.content).toContain('Paragraph one');
    expect(result?.content).toContain('Paragraph two');
    expect(result?.content).toContain('Paragraph three');
    expect(result?.suffix).toBe('Now my actual question?');
  });

  it('skips separator when suffix looks like paste data (log output)', () => {
    // Table offloaded, then log output follows — no user question.
    // The blank-line gap inside the log output should NOT split the offload.
    const input = [
      '$offload table',
      '',
      '┌──┬──┐',
      '│ a│ b│',
      '└──┴──┘',
      '',
      '🏃 Running init script: on_emulate.ts',
      'Executing: bun --tsconfig-override ...',
      'Working directory: /home/sonny/...',
      '◇ injected env (0) from .env',
      'Starting emulation seed...',
      'isEmulator true',
    ].join('\n');

    const result = parseOffload(input);
    expect(result).not.toBeNull();
    // All content is machine output — no conversational suffix to split on
    expect(result?.content).toContain('🏃 Running init script');
    expect(result?.content).toContain('isEmulator true');
    expect(result?.suffix).toBe('');
  });

  it('splits at separator when suffix is conversational, not paste', () => {
    // Table has a blank line, then a REAL user question follows
    const input = [
      '$offload table',
      '',
      '┌──┬──┐',
      '│ a│ b│',
      '└──┴──┘',
      '',
      '🏃 Running init script: on_emulate.ts',
      'isEmulator true',
      '',
      '',
      'Can you check why the emulator failed?',
    ].join('\n');

    const result = parseOffload(input);
    expect(result).not.toBeNull();
    // Content = table + log up to the last double-blank BEFORE the question
    expect(result?.content).toContain('🏃 Running init script');
    expect(result?.content).toContain('isEmulator true');
    expect(result?.suffix).toBe('Can you check why the emulator failed?');
  });

  it('scopes content to between $offload markers — all content is offload payload', () => {
    // When a second $offload marker follows, the content between the two
    // markers is the offload payload (no blank-line split within the bounded area).
    const input = [
      'Lets try',
      '',
      '$offload',
      'content1',
      '',
      '',
      'did that move it?',
      '',
      '$offload',
      'content2',
      '',
      '',
      'how about that',
    ].join('\n');

    // First block: everything between $offload and next $offload is content
    const result = parseOffload(input);
    expect(result).not.toBeNull();
    expect(result?.content).toContain('content1');
    expect(result?.content).toContain('did that move it?');
    // The second $offload marker + everything after is the remaining text
    expect(result?.suffix).toContain('$offload');
    expect(result?.suffix).toContain('content2');
    expect(result?.suffix).toContain('how about that');
  });

  it('returns prefix with the $offload marker text', () => {
    const input = '$offload my-logs\n\nErrors here';
    const result = parseOffload(input);
    expect(result).not.toBeNull();
    expect(result?.prefix).toBe('$offload my-logs');
  });

  it('tracks start and end positions in original text', () => {
    const input = '$offload\n\nLine 1\nLine 2';
    const result = parseOffload(input);
    expect(result).not.toBeNull();
    expect(result?.start).toBe(0);
    // Input after $offload + newline is 'Line 1\nLine 2'
    expect(typeof result?.end).toBe('number');
    if (result) {
      expect(result.end).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// explicitName()
// ═══════════════════════════════════════════════════════════════

describe('explicitName', () => {
  it('extracts name from $offload marker', () => {
    expect(explicitName('$offload my-logs')).toBe('my-logs');
    expect(explicitName('$offload prod-errors')).toBe('prod-errors');
    expect(explicitName('$offload build_output.log')).toBe('build_output.log');
  });

  it('returns null when no name is provided', () => {
    expect(explicitName('$offload')).toBeNull();
    expect(explicitName('$offload ')).toBeNull();
  });

  it('returns name when only whitespace after name', () => {
    expect(explicitName('$offload my-logs  ')).toBe('my-logs');
  });
});

// ═══════════════════════════════════════════════════════════════
// contentHash()
// ═══════════════════════════════════════════════════════════════

describe('contentHash', () => {
  it('returns a 12-character hex string', () => {
    const hash = contentHash('hello world');
    expect(hash).toHaveLength(12);
    expect(/^[a-f0-9]+$/.test(hash)).toBe(true);
  });

  it('returns same hash for identical content', () => {
    expect(contentHash('foo')).toBe(contentHash('foo'));
  });

  it('returns different hashes for different content', () => {
    expect(contentHash('foo')).not.toBe(contentHash('bar'));
  });
});

// ═══════════════════════════════════════════════════════════════
// buildSummary()
// ═══════════════════════════════════════════════════════════════

describe('buildSummary', () => {
  it('generates base summary with filepath, size, and line count', () => {
    const summary = buildSummary(
      '/tmp/pi-offloads/offload-abc123.txt',
      'Error line 1\nError line 2\nError line 3'
    );
    expect(summary).toContain('📋 offloaded');
    expect(summary).toContain('/tmp/pi-offloads/offload-abc123.txt');
    expect(summary).toContain('3 lines');
  });

  it('includes kind label when provided', () => {
    const summary = buildSummary('/tmp/x.txt', 'content', 'my custom kind');
    expect(summary).toContain('my custom kind');
  });

  it('auto-classifies content when no kind is given', () => {
    const summary = buildSummary('/tmp/x.txt', 'app.js  12.3 kB  gzip  4.5 kB');
    expect(summary).toContain('build output');
  });

  it('skips preview when includePreview is false', () => {
    const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7';
    const summary = buildSummary('/tmp/x.txt', content, undefined, false);
    expect(summary).toContain('📋 offloaded');
    expect(summary).not.toContain('Line 1');
  });

  it('includes preview by default', () => {
    const content = 'Line 1\nLine 2';
    const summary = buildSummary('/tmp/x.txt', content);
    expect(summary).toContain('📋 offloaded');
    expect(summary).toContain('Line 1');
  });
});

// ═══════════════════════════════════════════════════════════════
// isPaste — additional signals
// ═══════════════════════════════════════════════════════════════

describe('isPaste additional signals', () => {
  it('detects 100+ line content as paste', () => {
    const lines = Array.from({ length: 101 }, (_, i) => `Line ${i}`);
    expect(isPaste(lines.join('\n'))).toBe(true);
  });

  it('does not flag 99 lines as paste if no other signals', () => {
    const lines = Array.from({ length: 99 }, (_, i) => `Line ${i}`);
    expect(isPaste(lines.join('\n'))).toBe(false);
  });

  it('detects PANIC and CRITICAL labels', () => {
    expect(isPaste('2026-06-04 PANIC: kernel oops')).toBe(true);
    expect(isPaste('2026-06-04 CRITICAL: disk full')).toBe(true);
  });

  it('detects serviceAccount pattern', () => {
    expect(isPaste('serviceAccount: my-service@project.iam.gserviceaccount.com')).toBe(true);
  });

  it('detects CLI log prefixes', () => {
    expect(isPaste('i  functions: Loaded functions firebase/firestore-onWrite')).toBe(true);
    expect(isPaste('>  log something')).toBe(true);
    expect(isPaste('⚠  Multiple exports found')).toBe(true);
  });

  it('detects script milestone lines', () => {
    expect(isPaste('firebase Emulation seed: completed in 2.3s')).toBe(true);
    expect(isPaste('script Running: deploy.sh')).toBe(true);
    expect(isPaste('dotenvx Starting: inject phase')).toBe(true);
  });

  it('detects diamond/lozenge symbols', () => {
    expect(isPaste('◇ injected env (0) from .env')).toBe(true);
  });

  it('detects warning signs', () => {
    expect(isPaste('⚠ Multiple database instances detected')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// classify — additional content types
// ═══════════════════════════════════════════════════════════════

describe('classify additional types', () => {
  it('classifies task output by ▮ marker', () => {
    expect(classify('▮ Task started\n▮ Task completed')).toBe('task output');
  });

  it('classifies Uncaught errors as log output when timestamped', () => {
    expect(classify('[2026-06-04 14:32:01] Uncaught TypeError: foo is not a function')).toBe(
      'log output'
    );
  });

  it('does NOT classify box-drawing in non-first checks as log output', () => {
    // Box-drawing check comes before log output check
    expect(classify('┌──┐\n│ x│\n└──┘')).toBe('table');
  });
});

// ═══════════════════════════════════════════════════════════════
// cleanPreview — additional edge cases
// ═══════════════════════════════════════════════════════════════

describe('cleanPreview additional cases', () => {
  it('shows task output preview for ▮ content', () => {
    const text = '▮ Step 1\n▮ Step 2\n▮ Step 3\n▮ Step 4\n▮ Step 5';
    const preview = cleanPreview(text);
    expect(preview).toContain('▮ Step 1');
    expect(preview).toContain('▮ Step 5');
  });

  it('shows table preview with first 10 lines for │ tables', () => {
    const rows = Array.from({ length: 15 }, (_, i) => `│ row ${i + 1} │ value │`);
    const text = rows.join('\n');
    const preview = cleanPreview(text);
    expect(preview.split('\n').length).toBeLessThanOrEqual(10);
    expect(preview).toContain('row 1');
  });

  it('handles error with only one error line and no frames', () => {
    const text = 'Error: Something went wrong';
    const preview = cleanPreview(text);
    expect(preview).toContain('Error: Something went wrong');
  });

  it('handles fatal-only log without at-frames', () => {
    const text = 'FATAL: Out of memory\nProcess terminated';
    const preview = cleanPreview(text);
    expect(preview).toContain('FATAL: Out of memory');
  });

  it('trims empty leading lines in default preview', () => {
    const lines = ['', '', 'Actual content line 1', 'Actual content line 2'];
    const preview = cleanPreview(lines.join('\n'));
    expect(preview).toContain('Actual content line 1');
    // No leading newlines — content starts immediately
    expect(preview.startsWith('\n')).toBe(false);
    expect(preview.split('\n')[0]).toBe('Actual content line 1');
  });
});

// ═══════════════════════════════════════════════════════════════
// isConversational — additional edge cases
// ═══════════════════════════════════════════════════════════════

describe('isConversational additional cases', () => {
  it('returns false for empty string', () => {
    expect(isConversational('')).toBe(false);
  });

  it('returns false for whitespace-only', () => {
    expect(isConversational('   \n  \n  ')).toBe(false);
  });

  it('detects imperative-only text as conversational', () => {
    expect(isConversational('Please check the logs and create a fix')).toBe(true);
  });

  it('detects greeting + imperative combo', () => {
    expect(isConversational('Hey add logging')).toBe(true);
  });

  it('returns true for code block + question', () => {
    const text = '```js\nconst x = 1;\n```\n\nWhat does x equal?';
    expect(isConversational(text)).toBe(true);
  });

  it('returns false for pure symbol-heavy text', () => {
    expect(isConversational('=== RUN foo ===\n--- PASS: foo (0.01s)\n=== RUN bar ---')).toBe(false);
  });
});
