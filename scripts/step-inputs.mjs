// What each test step reads, derived from the code instead of kept by hand: a test file, every module it imports
// (static, dynamic and `new URL(..., import.meta.url)`), every repository file it names as path segments
// (`join(REPO_ROOT, 'src', 'cli.mjs')`, `resolve(THIS_DIR, '..', 'src', ...)`), and so on through those modules.
// A directory named that way counts as everything below it. Lanefather's scoped lane checks select a step when its
// inputs change (package-kit docs/reference.md, "Change-aware selection and planning").
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|new URL\(\s*)['"](\.{1,2}\/[^'"]*)['"]/g;
const SEGMENTS = /\b(?:join|resolve)\(\s*(REPO_ROOT|ROOT|THIS_DIR|__dirname)\s*((?:,\s*'[^']*'\s*)+)/g;

function references(root, file) {
  // Comments name paths as examples: only code counts (whole-line `//` comments and `/* */` blocks)
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found = new Set();
  for (const [, specifier] of text.matchAll(SPECIFIER)) found.add(resolve(dirname(file), specifier));
  for (const [, base, list] of text.matchAll(SEGMENTS)) {
    const parts = [...list.matchAll(/'([^']*)'/g)].map(match => match[1]);
    found.add(resolve(base === 'THIS_DIR' || base === '__dirname' ? dirname(file) : root, ...parts));
  }
  return [...found].filter(path => path.startsWith(root + '/') && existsSync(path));
}

/** The repository-relative inputs of these files: themselves and everything they reach. */
export function reachableInputs(root, files) {
  root = resolve(root);
  const seen = new Set(), inputs = new Set(), queue = files.map(file => resolve(root, file));
  while (queue.length) {
    const path = queue.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    const name = relative(root, path);
    if (name.startsWith('node_modules/')) continue;
    if (statSync(path).isDirectory()) { inputs.add(`${name.replace(/\/$/, '')}/**`); continue; }
    inputs.add(name);
    if (/\.(?:mjs|js)$/.test(path)) queue.push(...references(root, path));
  }
  return [...inputs].sort();
}

export const repositoryRoot = () => resolve(dirname(new URL(import.meta.url).pathname), '..');
