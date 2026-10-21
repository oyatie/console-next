// Mutation testing for the domain modules (npm run mutants; report in reports/mutation/).
// The command runner, not @stryker-mutator/vitest-runner: vitest-runner 10 filters each mutant's tests by
// "describe test" while Vitest 5 matches "describe > test", so every nested test is skipped and every
// runtime mutant falsely survives (measured: period.ts 6% vs 100% killed by hand). The command runner
// re-runs the features/ tests with __STRYKER_ACTIVE_MUTANT__ set: ~1 s per mutant, no per-test coverage, so
// uncovered mutants report as Survived rather than NoCoverage.
// ponytail: switch back to vitest-runner (perTest, faster) once it matches Vitest 5's " > " test names.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "command",
  commandRunner: { command: "npx vitest run apps/web/src/features/ --maxWorkers 2 --bail 1" },
  coverageAnalysis: "off",
  mutate: ["apps/web/src/features/*/domain/*.ts", "!apps/web/src/features/*/domain/*.test.ts"],
  concurrency: 4,
  reporters: ["clear-text", "progress", "json", "html"],
  ignorePatterns: ["docs", "e2e", "test-results*", "playwright-report", "apps/web/dist", "apps/desktop"],
};
