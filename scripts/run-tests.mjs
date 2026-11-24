#!/usr/bin/env node
// One verify step's test files (scripts/test-groups.mjs) under node:test: `node scripts/run-tests.mjs "<group>"`.
// A group runs its files two at a time; PACKAGE_KIT_WORKERS overrides it.
import { spawnSync } from 'node:child_process';
import { TEST_GROUPS, testFile } from './test-groups.mjs';

const name = process.argv[2];
const group = TEST_GROUPS[name];
if (!group) {
  console.error(`run-tests: unknown group "${name}"; groups: ${Object.keys(TEST_GROUPS).join(', ')}`);
  process.exit(2);
}
const workers = Math.max(1, Number(process.env.PACKAGE_KIT_WORKERS) || 2);
const result = spawnSync('node', ['--test', `--test-concurrency=${workers}`, ...group.files.map(testFile)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
