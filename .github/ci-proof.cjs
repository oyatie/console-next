// SPDX-License-Identifier: LicenseRef-Proprietary
async function source(github, context) {
  const params = { ...context.repo, per_page: 100 };
  const { data: candidate } = await github.rest.repos.getCommit({ ...context.repo, ref: context.sha });
  for await (const { data: runs } of github.paginate.iterator('GET /repos/{owner}/{repo}/actions/workflows/ci.yml/runs',
    { ...params, event: 'merge_group', status: 'success' })) {
    for (const run of runs) {
      if (run.path !== '.github/workflows/ci.yml' || run.event !== 'merge_group' || run.status !== 'completed' ||
          run.conclusion !== 'success' || !run.head_branch?.startsWith('gh-readonly-queue/dev/') ||
          run.repository?.id !== context.payload.repository.id || run.head_repository?.id !== context.payload.repository.id) continue;
      const { data: proven } = await github.rest.repos.getCommit({ ...context.repo, ref: run.head_sha });
      if (proven.commit.tree.sha !== candidate.commit.tree.sha) continue;
      const { data: comparison } = await github.rest.repos.compareCommits({ ...context.repo,
        base: context.payload.before, head: run.head_sha });
      if (comparison.merge_base_commit.sha !== context.payload.before) continue;
      const artifacts = await github.paginate('GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts',
        { ...params, run_id: run.id });
      const tools = artifacts.find(a => !a.expired && a.name.startsWith('cargo-security-'))?.name;
      if (!tools) throw new Error('CI_PROOF_TOOLS: missing trusted tool cache');
      return { id: run.id, sha: run.head_sha, tools };
    }
  }
  throw new Error('CI_PROOF_MISSING: dev tree has no successful trusted merge-group proof');
}
module.exports = { source };
