// SPDX-License-Identifier: LicenseRef-Proprietary
import {readFileSync} from 'node:fs';
import yaml from 'js-yaml';

// Exercise the job and step names actually emitted by the workflows, independently of promotion policy.
function liveBrowserJobs() {
  const {jobs} = yaml.load(readFileSync(new URL('../../../.github/workflows/e2e-live.yml', import.meta.url), 'utf8'));
  return Object.values(jobs).flatMap(job => {
    let names = [job.name];
    if (job.strategy) {
      const matrix = job.strategy.matrix;
      const shards = Array.isArray(matrix.shard) ? matrix.shard : Array.from({length:8}, (_, index) => index + 1);
      names = [...shards, ...(matrix.include ?? []).map(entry => entry.shard)].map(shard => job.name.replace('${{ matrix.shard }}', shard));
    }
    const steps = job.steps.filter(step => step.name).map(step => ({
      name:step.name.startsWith('Planned browser shards · ') ? 'Planned browser shards · 8/8/8' : step.name,
      status:'completed', conclusion:'success',
    }));
    return names.map(name => ({name, steps}));
  });
}

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
    const expected = workflow === 'e2e-live.yml' ? liveBrowserJobs() : [{name:'build'}, {name:'tests'}];
    jobs.set(id, expected.map(job => ({...job, run_id:id, head_sha:sha, run_attempt:1,
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
  const testsJob = run => jobs.get(run.id).find(job => job.name === (run === liveBrowser ? 'Chromium journeys · 1' : 'tests'));
  return {github, requests, runs, jobs, addRun, database, liveBrowser, routeLoad, testsJob};
}
