// SPDX-License-Identifier: LicenseRef-Proprietary
export async function pruneImageCache(github, context) {
  if (context.eventName !== 'push' || !context.payload.repository?.default_branch ||
      context.ref !== `refs/heads/${context.payload.repository.default_branch}`) {
    throw new Error('Image cache cleanup requires a default-branch push');
  }
  const caches = await github.paginate(github.rest.actions.getActionsCacheList, {...context.repo, per_page: 100});
  const legacy = cache => /^index-platform-(amd64|arm64)-1-[a-f0-9]{8}#\d+$/.test(cache.key);
  // Blobs are shared across scopes: reset them only before any new or unrelated image index exists.
  const reset = caches.some(legacy) && !caches.some(c => c.key.startsWith('index-') && !legacy(c));
  const obsolete = caches.filter(c => legacy(c) || (reset && /^buildkit-blob-1-sha256:[a-f0-9]{64}$/.test(c.key)));
  const result = {deleted: 0, bytes: 0};
  for (const cache of obsolete) {
    try {
      await github.rest.actions.deleteActionsCacheById({...context.repo, cache_id: cache.id});
      result.deleted++;
      result.bytes += cache.size_in_bytes;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  return result;
}
