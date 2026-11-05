import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog } from '../src/catalog.mjs';

test('resolves pinned catalog and validates its published revision and stories', async () => {
  const revision = 'a'.repeat(40), requests = [];
  const fetch = async (url) => {
    requests.push(url);
    return { ok: true, json: async () => url.endsWith('build.json')
      ? { revision, version: '1.2.3' } : { entries: { button: { id: 'button' } } } };
  };
  const catalog = await loadCatalog({ domain: 'example.test', revision, fetch });
  assert.equal(catalog.base, `https://example.test/releases/${revision}`);
  assert.equal(catalog.index.button.id, 'button');
  assert.equal(requests.length, 2);
  await assert.rejects(() => loadCatalog({ domain: 'example.test', revision: '../bad', fetch }), /revision/i);
  await assert.rejects(() => loadCatalog({ domain: 'example.test', revision: 'b'.repeat(40), fetch }), /revision/i);
});
