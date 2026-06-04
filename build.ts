#!/usr/bin/env bun

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = join(fileURLToPath(import.meta.url), '..');

console.log('📦 Preparing dist for npm publish...');

// Read package.json
const pkg = JSON.parse(await readFile(join(__dirname, 'package.json'), 'utf-8'));

// Clear dist at the start
await rm(join(__dirname, 'dist'), { recursive: true, force: true });
await mkdir(join(__dirname, 'dist'), { recursive: true });
await mkdir(join(__dirname, 'dist', 'src'), { recursive: true });

await Promise.all([
  // Copy source (pi handles .ts files natively — no compilation needed)
  cp(join(__dirname, 'src', 'index.ts'), join(__dirname, 'dist', 'src', 'index.ts')),

  // Copy README
  cp(join(__dirname, 'README.md'), join(__dirname, 'dist', 'README.md')),

  // Write trimmed package.json (remove dev-specific fields)
  (async () => {
    const { scripts, devDependencies, ...distPkg } = pkg;
    await writeFile(
      join(__dirname, 'dist', 'package.json'),
      `${JSON.stringify(distPkg, null, 2)}\n`
    );
  })(),
]);

console.log('✅ dist ready!');
