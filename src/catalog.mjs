/** Resolve a current or retained Storybook build. This never edits consumer pins. */
export async function loadCatalog({ domain, revision, fetch = globalThis.fetch }) {
  if (revision && !/^[a-f0-9]{40}$/.test(revision)) throw Error(`Invalid catalog revision: ${revision}`);
  const origin = /^https?:\/\//.test(domain) ? domain : `https://${domain}`;
  const base = origin.replace(/\/$/, '') + (revision ? `/releases/${revision}` : '');
  const get = async (path) => {
    const response = await fetch(`${base}/${path}`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error(`${base}/${path}: ${response.status}`);
    return response.json();
  };
  const [build, catalog] = await Promise.all([get('build.json'), get('index.json')]);
  if (!/^[a-f0-9]{40}$/.test(build.revision) || typeof build.version !== 'string') throw Error(`Invalid build manifest: ${base}`);
  if (revision && build.revision !== revision) throw Error(`Catalog revision mismatch: requested ${revision}, got ${build.revision}`);
  if (!catalog.entries || typeof catalog.entries !== 'object') throw Error(`Invalid story index: ${base}`);
  return { base, build, index: catalog.entries };
}
