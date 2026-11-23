// SPDX-License-Identifier: LicenseRef-Proprietary
export function suiteFixture(sha, repository) {
  const workflows = ['db-tests.yml', 'e2e-live.yml', 'route-load.yml'];
  const runs = {};
  const jobs = new Map();
  function addRun(workflow, event) {
    const id = jobs.size + 1;
    const run = {id, event, head_sha:sha, head_branch:'dev', head_repository:{full_name:repository},
      path:`.github/workflows/${workflow}`, run_attempt:1, status:'completed', conclusion:'success',
      html_url:`https://github.com/${repository}/actions/runs/${id}`};
    (runs[workflow] ??= []).unshift(run);
    jobs.set(id, ['build', 'tests'].map(name => ({name, run_id:id, head_sha:sha, run_attempt:1,
      status:'completed', conclusion:'success'})));
    return run;
  }
  const [db, live, load] = workflows.map((file, i) => addRun(file, ['push', 'schedule', 'workflow_dispatch'][i]));
  const requests = [];
  const github = {paginate:async (route, params) => {
    requests.push({route, params});
    return params.workflow_id ? runs[params.workflow_id] : jobs.get(params.run_id);
  }};
  return {github, requests, runs, jobs, addRun, db, live, load};
}
