// The gate's shape (package-kit.config.mjs): every test file runs in exactly one step, every tracked file is some
// step's input or named inert, and a lane check of a change runs the steps that change can break and no others.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { planChecks } from '@maxvyshniakov/package-kit/plan';
import config, { INERT } from '../package-kit.config.mjs';
import { TEST_GROUPS, testFile } from '../scripts/test-groups.mjs';
import { repositoryRoot } from '../scripts/step-inputs.mjs';

const ROOT = repositoryRoot();
const steps = config.verify.steps({ release: false });
const checks = steps.map(step => ({ id: `verify:${encodeURIComponent(step.name)}`, suite: 'verify', step }));
const plan = paths => planChecks({ checks, paths, inert: INERT, runner: config.verify.runner, canary: config.verify.canary });
const selected = paths => plan(paths).checks.filter(row => !row.producer).map(row => decodeURIComponent(row.id.slice('verify:'.length))).sort();

test('every test file runs in exactly one step', () => {
  const files = readdirSync(`${ROOT}/test`).filter(name => name.endsWith('.test.mjs')).map(name => `test/${name}`).sort();
  const grouped = Object.values(TEST_GROUPS).flatMap(group => group.files.map(testFile)).sort();
  assert.deepEqual(grouped, files);
});

test('every tracked file is some step\'s input, the gate\'s own, or inert', () => {
  const tracked = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const unowned = tracked.filter(file => plan([file]).unowned.length);
  assert.deepEqual(unowned, [], 'name these in a step\'s inputs or in INERT (package-kit.config.mjs)');
});

test('a lane check runs what a change can break, not the whole gate', () => {
  const cheap = ['lint'];
  // A test file: its own step
  assert.deepEqual(selected(['test/terminal-render.test.mjs']), [...cheap, 'terminal tests'].sort());
  assert.deepEqual(selected(['test/render-timeline.test.mjs']), [...cheap, 'render tests'].sort());
  // Prose: only what always runs
  assert.deepEqual(selected(['docs/agents/checks.md', 'README.md']), cheap);
  // A module few tests reach runs only theirs; a fixture, only the tests that load it
  assert.deepEqual(selected(['src/catalog.mjs']), [...cheap, 'pipeline tests']);
  assert.deepEqual(selected(['test/fixtures/benchmarks/recipes.mjs']), [...cheap, 'pipeline tests'].sort());
  // A workflow: the kit's pins and the tests that read it
  assert.deepEqual(selected(['.github/workflows/ci.yml']), ['kit', 'lint', 'pipeline tests', 'render tests']);
  // The lockfile runs everything
  assert.equal(plan(['bun.lock']).full, true);
  // The gate's own configuration runs its canaries
  assert.deepEqual(selected(['scripts/test-groups.mjs']), ['gate tests', 'kit', 'lint']);
});
