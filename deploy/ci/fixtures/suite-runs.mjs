// SPDX-License-Identifier: LicenseRef-Proprietary
export function suiteRunsFixture(sha, repository) {
  const events = {'db-tests.yml':'push', 'e2e-live.yml':'schedule', 'route-load.yml':'workflow_dispatch'};
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
  for (const [workflow, event] of Object.entries(events)) addRun(workflow, event);
  const requests = [];
  const github = {paginate:async (route, params) => {
    requests.push({route, params});
    return params.workflow_id ? runs[params.workflow_id] : jobs.get(params.run_id);
  }};
  const [database] = runs['db-tests.yml'];
  const [liveBrowser] = runs['e2e-live.yml'];
  const [routeLoad] = runs['route-load.yml'];
  const testsJob = run => jobs.get(run.id).find(job => job.name === 'tests');
  return {github, requests, runs, jobs, addRun, database, liveBrowser, routeLoad, testsJob};
}
