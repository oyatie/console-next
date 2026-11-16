// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import gatesPolicy from '../gates.json' with {type:'json'};

export function readEnvironment(environment, root = '.') {
  assert.match(environment ?? '', /^[a-z0-9][a-z0-9-]*$/, 'PLAT_OVERLAY: select a committed environment');
  const directory = join(root, 'deploy/clusters', environment);
  assert.ok(existsSync(directory) && lstatSync(directory).isDirectory() &&
    existsSync(join(directory, 'platform.json')) && lstatSync(join(directory, 'platform.json')).isFile(),
  'PLAT_OVERLAY: select a committed environment');
  const config = JSON.parse(readFileSync(join(directory, 'platform.json'), 'utf8'));
  if (config.target !== undefined || config.channel !== undefined) {
    assert.ok(['host', 'kubernetes'].includes(config.target) && typeof config.channel === 'string' &&
      /^[a-z0-9][a-z0-9_.-]*$/.test(config.channel) && config.channel.length <= 87,
    'PROMOTE_ENVIRONMENT: target and channel must be valid; reserve room for the immutable SHA tag');
  }
  return config;
}

export function discoverEnvironments(root = '.') {
  const channels = new Set();
  return readdirSync(join(root, 'deploy/clusters'), {withFileTypes:true})
    .filter(entry => entry.isDirectory()).map(entry => {
      const {target, channel} = readEnvironment(entry.name, root);
      if (channel === undefined) return null;
      assert.ok(!channels.has(channel), 'PROMOTE_ENVIRONMENT: channels must be unique');
      channels.add(channel);
      return {environment:entry.name, target, channel};
    }).filter(Boolean).sort((a, b) => a.environment.localeCompare(b.environment));
}

export function assertPromotion({sha, repository, run, jobs, gatesResult, currentRevision}, root = '.') {
  assert.ok(typeof repository === 'string' && repository.length > 0 && run?.event === 'push' &&
    run.head_branch === 'dev' && run.head_repository?.full_name === repository,
  'PROMOTE_FORK: require a dev push in this repository');
  assert.ok(typeof sha === 'string' && /^(?!0{40}$)[a-f0-9]{40}$/.test(sha) && run.path === '.github/workflows/platform.yml' &&
    run.head_sha === sha && run.status === 'completed' && run.conclusion === 'success' &&
    Number.isSafeInteger(run.id) && run.id > 0 && Array.isArray(jobs) && jobs.length > 0 &&
    new Set(jobs.map(job => job?.id)).size === jobs.length && jobs.every(job =>
      Number.isSafeInteger(job?.id) && job.id > 0 && typeof job.name === 'string' && job.name.length > 0 &&
      job.run_id === run.id && job.head_sha === sha &&
      job.status === 'completed' && job.conclusion === 'success'),
  'PROMOTE_NOT_GREEN: require completed successful jobs for this platform run and SHA');
  const workflow = load(readFileSync(join(root, '.github/workflows/platform.yml'), 'utf8'));
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const matrix = job.strategy?.matrix;
    if (!matrix) {
      assert.ok(jobs.some(actual => actual.name === name || actual.name.startsWith(`${name} / `)),
        `PROMOTE_NOT_GREEN: missing ${name}`);
      continue;
    }
    // GitHub's default matrix job names follow the declared axis order.
    assert.ok(!matrix.exclude && (!matrix.include || Object.keys(matrix).length === 1),
      'PROMOTE_NOT_GREEN: unsupported matrix; update proof inventory before changing the workflow');
    const rows = matrix.include?.map(row => Object.values(row)) ?? Object.values(matrix)
      .reduce((combinations, values) => {
        if (typeof values === 'string') {
          // Resolve only the event-conditioned JSON axis used by scheduled repetitions; never evaluate workflow code.
          const expression = values.match(/^\$\{\{ fromJSON\(github\.event_name == '([a-z_]+)' && '(\[[\d, ]+\])' \|\| '(\[[\d, ]+\])'\) \}\}$/);
          assert.ok(expression, 'PROMOTE_NOT_GREEN: unsupported matrix expression');
          values = JSON.parse(expression[run.event === expression[1] ? 2 : 3]);
          assert.ok(values.length > 0, 'PROMOTE_NOT_GREEN: empty matrix axis');
        }
        return combinations.flatMap(row => values.map(value => [...row, value]));
      }, [[]]);
    const expected = rows.map(row => `${name} (${row.join(', ')})`).sort();
    const actual = jobs.filter(actualJob => actualJob.name.startsWith(`${name} (`)).map(actualJob => actualJob.name).sort();
    assert.deepEqual(actual, expected, `PROMOTE_NOT_GREEN: require every ${name} matrix job exactly once`);
  }
  assert.equal(gatesResult, 'pass', 'PROMOTE_GATES: release gates must pass');
  assert.ok(currentRevision === null ||
    spawnSync('git', ['rev-parse', '--is-shallow-repository'], {cwd:root, encoding:'utf8'}).stdout?.trim() === 'false',
  'PROMOTE_NOT_DESCENDANT: channel ancestry requires a full checkout (fetch-depth: 0)');
  assert.ok(currentRevision === null || typeof currentRevision === 'string' &&
    /^(?!0{40}$)[a-f0-9]{40}$/.test(currentRevision) &&
    spawnSync('git', ['merge-base', '--is-ancestor', currentRevision, sha], {cwd:root}).status === 0,
  'PROMOTE_NOT_DESCENDANT: channel history must be known and an ancestor of the candidate');
}

export function validatePredicate(predicate, sha, runUrl) {
  assert.ok(predicate?.inputs?.backend === sha && predicate.inputs.web === sha &&
    predicate.runner?.kind === 'gha' && typeof runUrl === 'string' &&
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/.test(runUrl) &&
    predicate.runner.url === runUrl &&
    ['normal', 'long'].includes(predicate.bake) && predicate.approver === null &&
    Array.isArray(predicate.gates) && predicate.gates.length === Object.keys(gatesPolicy.checks).length &&
    new Set(predicate.gates.map(gate => gate?.name)).size === predicate.gates.length &&
    predicate.gates.every(gate => Object.hasOwn(gatesPolicy.checks, gate?.name) && gate.result === 'pass'),
  'PROMOTE_GATES: require the complete passing predicate for this SHA and promotion run');
}

export async function collectPlatformProof(github, repository, runId, root = '.') {
  assert.ok(Number.isSafeInteger(runId) && runId > 0, 'PROMOTE_NOT_GREEN: select a platform run');
  const [owner, repo] = repository.split('/');
  const {data:run} = await github.rest.actions.getWorkflowRun({owner, repo, run_id:runId});
  assert.ok(run.id === runId && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0,
    'PROMOTE_NOT_GREEN: require the selected run and a known attempt');
  const jobs = await github.paginate('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',
    {owner, repo, run_id:runId, attempt_number:run.run_attempt, per_page:100});
  const proof = {sha:run.head_sha, repository, run, jobs, gatesResult:'pass', currentRevision:null};
  assertPromotion(proof, root);
  return proof;
}

const executeTool = (bin, args, options = {}) => execFileSync(bin, args, {
  encoding:'utf8', maxBuffer:64 * 1024 * 1024, ...options,
});

// Resolve mutable tags once, then verify and pull only that digest.
export function publishEnvironment({proof, environment, predicate, runUrl, directory, root = '.', candidateRoot = root}, execute = executeTool) {
  validatePredicate(predicate, proof.sha, runUrl);
  assertPromotion(proof, root);
  const {channel} = readEnvironment(environment, root);
  assert.ok(channel, 'PROMOTE_ENVIRONMENT: select a configured channel');
  const deploy = `ghcr.io/${proof.repository.toLowerCase()}/console-deploy`;
  const issuer = '--certificate-oidc-issuer=https://token.actions.githubusercontent.com';
  const identity = workflow => `--certificate-identity=https://github.com/${proof.repository}/.github/workflows/${workflow}.yml@refs/heads/dev`;
  const type = 'https://cosskorea.com/attestations/console-gates/v1';
  const signatureRefusal = /no (matching )?signatures?|none of the expected identities matched|certificate.*(identity|subject)/i;
  const resolve = (tag, optional = false) => {
    let result;
    try { result = execute('buildx', ['imagetools', 'inspect', `${deploy}:${tag}`, '--format', '{{json .Manifest}}']); }
    catch (error) {
      const absent = /MANIFEST_UNKNOWN|manifest unknown/i.test(String(error.stderr)) ||
        String(error.stderr).trim() === `ERROR: ${deploy}:${tag}: not found`;
      if (optional && absent) return null;
      throw error;
    }
    const {digest} = JSON.parse(result);
    assert.match(digest ?? '', /^sha256:[a-f0-9]{64}$/, 'PROMOTE_ARTIFACT: require an OCI digest');
    return `${deploy}@${digest}`;
  };
  const pull = (ref, name, workflow) => {
    if (workflow) execute('cosign', ['verify', issuer, identity(workflow), ref]);
    const output = join(directory, name);
    mkdirSync(output, {recursive:true});
    execute('flux', ['pull', 'artifact', `oci://${ref}`, `--output=${output}`]);
    return {output, revision:JSON.parse(readFileSync(join(output, 'revision.json'), 'utf8'))};
  };
  const current = resolve(channel, true);
  let currentRevision = null;
  if (current) {
    const {revision} = pull(current, 'current', 'promote');
    assert.equal(revision.environment, environment, 'PROMOTE_ENVIRONMENT: channel environment mismatch');
    currentRevision = revision.revision;
  }
  assertPromotion({...proof, currentRevision}, root);
  const immutableTag = `${channel}-${proof.sha}`;
  let artifact = resolve(immutableTag, true);
  const shadow = resolve(`shadow-${proof.sha}`);
  const {output, revision} = pull(shadow, 'shadow', 'platform');
  assert.equal(revision.revision, proof.sha, 'PROMOTE_NOT_GREEN: shadow must match the platform SHA');
  const imageRepository = `ghcr.io/${proof.repository.toLowerCase()}/console`;
  assert.ok(revision.image?.startsWith(`${imageRepository}@sha256:`), 'PROMOTE_ARTIFACT: unexpected image repository');
  assert.match(revision.image, /@sha256:[a-f0-9]{64}$/, 'PROMOTE_ARTIFACT: require the built image digest');
  const bundle = join(directory, 'bundle');
  execute(process.execPath, [join(import.meta.dirname, 'render.mjs'), environment, revision.image, bundle],
    {cwd:candidateRoot, env:{...process.env, GITHUB_SHA:proof.sha}});
  if (readEnvironment(environment, candidateRoot).target === 'kubernetes') {
    execute('bash', [join(import.meta.dirname, 'validate.sh'), bundle], {cwd:candidateRoot});
  }
  cpSync(join(output, 'image-sbom.json'), join(bundle, 'image-sbom.json'));
  if (artifact) {
    // A prior attempt may have pushed before signing; authorize its bytes against the verified build.
    const {output:existing} = pull(artifact, 'immutable');
    const files = readdirSync(bundle, {recursive:true}).sort();
    assert.deepEqual(readdirSync(existing, {recursive:true}).sort(), files,
      'PROMOTE_ARTIFACT: immutable contents differ from the verified build');
    for (const file of files) {
      const expected = lstatSync(join(bundle, file));
      const actual = lstatSync(join(existing, file));
      assert.ok(expected.isDirectory() ? actual.isDirectory() : expected.isFile() && actual.isFile() &&
        readFileSync(join(bundle, file)).equals(readFileSync(join(existing, file))),
      'PROMOTE_ARTIFACT: immutable contents differ from the verified build');
    }
  } else {
    const {digest} = JSON.parse(execute('flux', ['push', 'artifact', `oci://${deploy}:${immutableTag}`,
      `--path=${bundle}`, `--source=https://github.com/${proof.repository}`, `--revision=${proof.sha}`, '--output=json']));
    assert.match(digest ?? '', /^sha256:[a-f0-9]{64}$/, 'PROMOTE_ARTIFACT: require the published digest');
    artifact = `${deploy}@${digest}`;
    assert.throws(() => execute('cosign', ['verify', issuer, identity('promote'), artifact]), signatureRefusal,
      'PROMOTE_ARTIFACT: unsigned negative control unexpectedly verified');
  }
  execute('cosign', ['sign', '--yes', artifact]);
  execute('cosign', ['attest', '--yes', '--type', type, '--predicate', join(directory, 'console-gates.json'), artifact]);
  execute('cosign', ['verify', issuer, identity('promote'), artifact]);
  assert.throws(() => execute('cosign', ['verify', issuer, identity('platform'), artifact]), signatureRefusal,
    'PROMOTE_ARTIFACT: build identity must not verify a promotion');
  let statements;
  try {
    const envelopes = execute('cosign', ['verify-attestation', '--type', type, issuer, identity('promote'), artifact]);
    statements = envelopes.trim().split('\n').flatMap(line => JSON.parse(line))
      .map(envelope => JSON.parse(Buffer.from(envelope.payload, 'base64').toString()));
  } catch (cause) { throw new Error('PROMOTE_GATES: missing or unverifiable gates attestation', {cause}); }
  assert.ok(statements.length > 0, 'PROMOTE_GATES: missing gates attestation');
  for (const statement of statements) {
    assert.ok(statement.predicateType === type && statement.subject?.some(subject =>
      subject.digest?.sha256 === artifact.split(':').at(-1)), 'PROMOTE_GATES: attestation subject mismatch');
    // An immutable artifact may have been attested by an earlier successful promotion attempt.
    validatePredicate(statement.predicate, proof.sha, statement.predicate?.runner?.url);
    assert.ok(statement.predicate.runner.url.startsWith(`https://github.com/${proof.repository}/actions/runs/`),
      'PROMOTE_GATES: attestation must belong to this repository');
  }
  execute('flux', ['tag', 'artifact', `oci://${artifact}`, `--tag=${channel}`]);
  return artifact;
}
