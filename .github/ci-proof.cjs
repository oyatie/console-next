// SPDX-License-Identifier: LicenseRef-Proprietary
const completed = (run, workflow, repositoryId) => run.path === `.github/workflows/${workflow}` && run.status === 'completed' &&
  run.repository?.id === repositoryId && run.head_repository?.id === repositoryId;
const succeeded = (run, workflow, repositoryId) => completed(run, workflow, repositoryId) && run.conclusion === 'success';

async function source(github, context) {
  const params = { ...context.repo, per_page: 100 };
  const { data: candidate } = await github.rest.repos.getCommit({ ...context.repo, ref: context.sha });
  for await (const { data: runs } of github.paginate.iterator('GET /repos/{owner}/{repo}/actions/workflows/ci.yml/runs',
    { ...params, event: 'merge_group', status: 'success', head_sha: context.sha })) {
    for (const run of runs) {
      if (run.event !== 'merge_group' || !run.head_branch?.startsWith('gh-readonly-queue/dev/') ||
          !succeeded(run, 'ci.yml', context.payload.repository.id)) continue;
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

/**
 * Newest first, the artifacts whose producing run is this repository's completed `workflow` run for one of `events` on dev.
 * The run must have succeeded unless `anyConclusion` is set, which suits measurements a red run still publishes complete.
 */
async function* trustedArtifacts(artifacts, api, repositoryId, workflow, events, { anyConclusion = false } = {}) {
  let tip;
  const listed = artifacts.filter(a => !a.expired && a.workflow_run?.head_branch === 'dev')
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  for (const artifact of listed) {
    const run = await api(`actions/runs/${artifact.workflow_run.id}`);
    if (!events.includes(run.event) || run.head_branch !== 'dev' || !(anyConclusion ? completed : succeeded)(run, workflow, repositoryId)) continue;
    tip ??= (await api('branches/dev')).commit.sha;
    // head_branch is only a ref name; the run's commit must also be on dev's history.
    if (['ahead', 'identical'].includes((await api(`compare/${run.head_sha}...${tip}`)).status)) yield artifact;
  }
}

module.exports = { source, trustedArtifacts };

// node .github/ci-proof.cjs [--any-conclusion] <artifact name> <workflow file> <event>... writes run-id=<newest trusted producing run>.
if (require.main === module) {
  const args = process.argv.slice(2);
  const anyConclusion = args[0] === '--any-conclusion';
  const [name, workflow, ...events] = anyConclusion ? args.slice(1) : args;
  const api = async route => {
    const response = await fetch(`${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}/${route}`, {
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error(`CI_PROOF_FETCH: ${route} answered HTTP ${response.status}`);
    return response.json();
  };
  (async () => {
    const { artifacts } = await api(`actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`);
    for await (const { workflow_run: run } of trustedArtifacts(artifacts, api, Number(process.env.GITHUB_REPOSITORY_ID), workflow, events, { anyConclusion }))
      return require('node:fs').appendFileSync(process.env.GITHUB_OUTPUT, `run-id=${run.id}\n`);
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
