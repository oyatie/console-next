// Records each passing test's duration (scripts/e2e-timings.mjs), which scripts/e2e-slot.mjs plans shards from.
import path from "node:path";
import { record, testKey } from "../scripts/e2e-timings.mjs";

export default class TimingsReporter {
  seen = {};
  onBegin(config) {
    this.root = config.rootDir;
  }
  onTestEnd(test, result) {
    if (result.status !== "passed") return;
    const [, project, , ...titles] = test.titlePath();
    this.seen[testKey(project, path.relative(this.root, test.location.file), titles)] = result.duration / 1000;
  }
  onEnd() {
    if (Object.keys(this.seen).length) record(this.seen);
  }
  printsToStdio() {
    return false;
  }
}
