import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const MODULES = [
  'schema.js',
  'geometry.js',
  'printcheck.js',
  'stl.js',
  'lifecycle.js',
  'prompts.js',
  'exportbundle.js',
  'model.js',
  'viewport.js',
  'app.js',
];
const ALLOWED_HOST = 'https://cdnjs.cloudflare.com/';

export function stripModuleSyntax(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*import\s.*from\s+['"].*['"];?\s*$/.test(line))
    .map((line) => line.replace(/^export\s+(default\s+)?/, ''))
    .join('\n');
}

export function buildPage(page, modules) {
  for (const m of page.matchAll(/<script[^>]*src="([^"]+)"/g)) {
    if (!m[1].startsWith(ALLOWED_HOST))
      throw new Error(`external script must come from cdnjs: ${m[1]}`);
  }
  if (!page.includes('<!-- @inline-modules -->'))
    throw new Error('page.html lacks <!-- @inline-modules --> marker');
  const body = modules
    .map((m) => `// --- ${m.name} ---\n${stripModuleSyntax(m.source)}`)
    .join('\n');
  return page.replace('<!-- @inline-modules -->', `<script>\n'use strict';\n${body}\n</script>`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const page = readFileSync(join(root, 'src/page.html'), 'utf8');
  const modules = MODULES.filter((n) => {
    try {
      statSync(join(root, 'src', n));
      return true;
    } catch {
      return false;
    }
  }).map((n) => ({ name: n, source: readFileSync(join(root, 'src', n), 'utf8') }));
  const out = buildPage(page, modules);
  writeFileSync(join(root, 'index.html'), out);
  const kb = Buffer.byteLength(out) / 1024;
  if (kb > 1024) throw new Error(`index.html is ${kb.toFixed(0)} KB, over the 1 MB limit`);
  console.log(`index.html written, ${kb.toFixed(1)} KB, ${modules.length} modules`);
}
