import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureRun, statusRun, hash } from '../src/run.mjs';
import { reviewRun } from '../src/review.mjs';

test('invalid sources fail before creating a misleading output directory', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'screen-kit-core-'));
  try {
    await assert.rejects(captureRun({ config: { recipes: { sample: { source: 'imaginary' } } }, cwd, out: join(cwd, 'out') }), /unsupported source/);
    assert.deepEqual(await readdir(cwd), []);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a real PTY run records input checkpoints and verifiable output provenance', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'screen-kit-core-pty-'));
  try {
    const config = { recipes: { navigation: {
      source: 'terminal', format: 'png', columns: 40, rows: 8, duration: 1.4,
      command: ['python3', '-u', '-c', 'import os,tty,time; tty.setraw(0); print("\\x1b[2J\\x1b[Hselected alpha",flush=True); os.read(0,3); print("\\r\\nselected beta",flush=True); time.sleep(2)'],
      steps: [{ at: 0.4, input: '\x1b[B', expect: 'selected beta', settle: 0.2 }],
    } } };
    const out = join(cwd, 'out');
    const report = await captureRun({ config, cwd, out });
    assert.equal(report.status, 'complete');
    assert.equal(report.recipes.navigation.status, 'complete');
    assert.equal(report.recipes.navigation.checkpoints[0].passed, true);
    assert.equal(report.recipes.navigation.sha256, hash(await readFile(join(out, report.recipes.navigation.file))));
    assert.equal((await reviewRun({ manifest: join(out, 'run.json') })).ok, true);
    assert.equal((await statusRun({ config, cwd, manifest: join(out, 'run.json') })).recipes.navigation.recipeChanged, false);
    config.recipes.navigation.columns = 50;
    assert.equal((await statusRun({ config, cwd, manifest: join(out, 'run.json') })).recipes.navigation.recipeChanged, true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('failed capture retains a failed manifest instead of a successful artifact entry', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'screen-kit-core-failure-'));
  try {
    const out = join(cwd, 'out');
    await assert.rejects(captureRun({ cwd, out, config: { recipes: { missing: {
      source: 'terminal', command: ['/this/command/does/not/exist'], duration: 0.2,
    } } } }), /failed|No such file/i);
    const report = JSON.parse(await readFile(join(out, 'run.json'), 'utf8'));
    assert.equal(report.status, 'failed');
    assert.equal(report.recipes.missing.status, 'failed');
    assert.equal((await reviewRun({ manifest: join(out, 'run.json') })).ok, false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('raw asciicast captures pass review and reject out-of-order events even when their hash matches', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'screen-kit-core-cast-'));
  try {
    const out = join(cwd, 'out');
    const report = await captureRun({ cwd, out, config: { recipes: { terminal: {
      source: 'terminal', format: 'cast', columns: 30, rows: 6, duration: 0.6,
      command: ['python3', '-u', '-c', 'import time; print("real terminal output",flush=True); time.sleep(2)'],
    } } } });
    const manifest = join(out, 'run.json');
    assert.equal((await reviewRun({ manifest })).ok, true);
    const file = join(out, report.recipes.terminal.file);
    const records = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    records[1][0] = 5;
    const invalid = records.map(record => JSON.stringify(record)).join('\n') + '\n';
    await writeFile(file, invalid);
    report.recipes.terminal.sha256 = hash(invalid);
    await writeFile(manifest, JSON.stringify(report));
    const review = await reviewRun({ manifest });
    assert.equal(review.ok, false);
    assert.ok(review.checks.some(check => !check.ok && /ordered/i.test(check.message)));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
