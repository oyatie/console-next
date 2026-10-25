// SPDX-License-Identifier: LicenseRef-Proprietary
// Duration-based planning shared by local slots and GitHub Actions; callers supply timings and execution mode.
const FALLBACK_S = 10; // per test, when nothing is recorded yet

/** `file` is relative to e2e/; served and dev runs keep separate duration histories. */
export const testKey = (project, file, titles, served = false) => [served ? `served:${project}` : project, file, ...titles].join(" › ");

/** The tests a `playwright test --list --reporter=json` run would execute, as `{project, file, key}`. */
export function listedTests(report, served = false) {
  const tests = [];
  const walk = (suite, file, titles) => {
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests)
        if (t.expectedStatus !== "skipped") tests.push({ project: t.projectName, file, key: testKey(t.projectName, file, [...titles, spec.title], served) });
    for (const child of suite.suites ?? []) walk(child, file, [...titles, child.title]);
  };
  for (const fileSuite of report.suites) walk(fileSuite, fileSuite.file, []);
  return tests;
}

/**
 * Splits the listed tests into jobs of at most `target` seconds each: per project, ceil(estimate / budget) shards,
 * whole files packed longest-first into the lightest shard. A job's estimate is `boot` plus its seconds over the
 * project's workers ("clock" runs one at a time). maxSeconds opens another bin rather than overfilling it.
 * Returns [] when the whole run fits in one job.
 */
export function plan(tests, timings, { target = 300, workers = 4, boot = 40, maxSeconds = Infinity } = {}) {
  target = Math.min(target, maxSeconds);
  const known = tests.map((t) => timings[t.key]?.s).filter((s) => s !== undefined).sort((a, b) => a - b);
  const median = known.length ? known[known.length >> 1] : FALLBACK_S;
  const projects = new Map();
  for (const t of tests) {
    const files = projects.get(t.project) ?? projects.set(t.project, new Map()).get(t.project);
    files.set(t.file, (files.get(t.file) ?? 0) + (timings[t.key]?.s ?? median));
  }
  const width = (project) => (project === "clock" ? 1 : workers);
  const sum = (files) => [...files.values()].reduce((a, b) => a + b, 0);
  const whole = boot + [...projects].reduce((acc, [p, files]) => acc + sum(files) / width(p), 0);
  if (whole <= target) return [];
  const budget = Math.max(target - boot, 30);
  return [...projects].flatMap(([project, files]) => {
    const bins = Array.from({ length: Math.ceil(sum(files) / width(project) / budget) }, () => ({ project, files: [], s: 0 }));
    for (const [file, s] of [...files].sort((a, b) => b[1] - a[1])) {
      if (Math.round(boot + s / width(project)) > maxSeconds) throw new Error(`E2E file exceeds timeout headroom: ${file}`);
      let bin = bins.reduce((a, b) => (b.s < a.s ? b : a));
      if (Math.round(boot + (bin.s + s) / width(project)) > maxSeconds) {
        bin = { project, files: [], s: 0 };
        bins.push(bin);
      }
      bin.files.push(file);
      bin.s += s;
    }
    return bins.filter((b) => b.files.length).map((b) => ({ project, files: b.files, est: Math.round(boot + b.s / width(project)) }));
  });
}
