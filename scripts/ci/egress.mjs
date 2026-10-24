// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";

// Network contracts include redirects and cold-cache paths, even when a warm run skips them.
// Keep indirect script calls here too: cargo metadata invokes rustup before Cargo starts.
const tools = {
  "github-release": { endpoints: ["github.com:443", "release-assets.githubusercontent.com:443"] },
  "actions/checkout": { endpoints: ["github.com:443", "api.github.com:443", "codeload.github.com:443"] },
  "actions/setup-node": {
    needs: ["github-release"],
    endpoints: ["api.github.com:443", "raw.githubusercontent.com:443", "objects.githubusercontent.com:443", "nodejs.org:443"],
  },
  "actions/cache/restore": { endpoints: ["*.actions.githubusercontent.com:443", "*.blob.core.windows.net:443"] },
  "actions/cache/save": { needs: ["actions/cache/restore"] },
  "actions/upload-artifact": { needs: ["actions/cache/restore"] },
  "actions/download-artifact": { needs: ["actions/cache/restore"] },
  "github/codeql-action/init": {
    needs: ["github-release", "actions/cache/restore", "ghcr"],
    endpoints: ["api.github.com:443", "raw.githubusercontent.com:443", "objects.githubusercontent.com:443"],
  },
  "github/codeql-action/analyze": { endpoints: ["api.github.com:443", "uploads.github.com:443"] },
  "step-security/harden-runner": { endpoints: [] }, // The action manages its own control-plane endpoints.
  rustup: { run: /\b(?:rustup|cargo)\s/, endpoints: ["static.rust-lang.org:443"] },
  cargo: { run: /\bcargo\s+(?:fetch|build|clippy|check)\b/, endpoints: ["index.crates.io:443", "static.crates.io:443"] },
  npm: { run: /\bnpm\s+(?:ci|install)\b/, endpoints: ["registry.npmjs.org:443"] },
  playwright: {
    run: /\bplaywright\s+install\b/,
    endpoints: ["cdn.playwright.dev:443", "playwright.download.prss.microsoft.com:443", "storage.googleapis.com:443"],
  },
  apt: {
    run: /\bplaywright\s+install\b[^\n]*--with-deps|\bapt-get\s+(?:update|install)\b/,
    // ubuntu-24.04 uses the runner image's Azure mirror, with HTTPS archive/security fallbacks.
    // https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/configure-apt-sources.sh
    endpoints: ["azure.archive.ubuntu.com:80", "archive.ubuntu.com:443", "security.ubuntu.com:443", "packages.microsoft.com:443"],
  },
  docker: {
    run: /\bdocker\s+(?:run|pull)\b(?![^\n]*\bghcr\.io\/)|\bdocker\s+compose\b/,
    endpoints: ["registry-1.docker.io:443", "auth.docker.io:443", "production.cloudflare.docker.com:443", "production.cloudfront.docker.com:443"],
  },
  ghcr: { run: /\bghcr\.io\//, endpoints: ["ghcr.io:443", "pkg-containers.githubusercontent.com:443"] },
  gh: { run: /\bgh\s+(?:api|run)\b/, endpoints: ["api.github.com:443"] },
  telegram: { run: /notify-telegram\.sh\s+(?:send|health)\b/, endpoints: ["api.telegram.org:443"] },
  "ci-plan": { run: /scripts\/ci\/plan\.mjs\b/, needs: ["rustup"] },
  "ci-rust-build": { run: /scripts\/ci\/rust-build\.mjs\b/, needs: ["rustup", "cargo", "sccache"] },
  "ci-rust-tests": { run: /scripts\/ci\/rust-tests\.mjs\b/, needs: ["rustup"] },
  "ci-e2e": { run: /scripts\/ci\/e2e\.mjs\s+run\b/, needs: ["docker"] },
  "ci-cache-metrics": { env: { CI_CACHE_TOTAL: "1" }, needs: ["gh"] },
  probe: { env: { URL: "${{ secrets.PROBE_URL }}" }, endpoints: ["${{ secrets.CONSOLE_PUBLIC_HOST }}:443"] },
  sccache: { run: /\bsccache\b/, endpoints: [] }, // SCCACHE_DIR is local; actions/cache transfers it.
};

export function requiredEndpoints(job) {
  const required = new Set();
  function use(name) {
    const tool = tools[name];
    if (!tool) throw new Error(`unmapped network tool: ${name}`);
    for (const dependency of tool.needs ?? []) use(dependency);
    for (const endpoint of tool.endpoints ?? []) required.add(endpoint);
  }
  for (const step of job.steps ?? []) {
    if (step.uses) use(step.uses.split("@")[0]);
    const command = step.run ?? "";
    for (const [name, tool] of Object.entries(tools)) {
      if (tool.run?.test(command) || (tool.env && Object.entries(tool.env).every(([key, value]) => (step.env?.[key] ?? job.env?.[key]) === value))) use(name);
    }
    for (const [, names] of command.matchAll(/scripts\/ci\/install-tools\.sh\s+([\w -]+)/g)) {
      const versions = JSON.parse(readFileSync(new URL("./versions.json", import.meta.url), "utf8"));
      for (const name of names.trim().split(/\s+/)) {
        const pin = versions[name];
        if (!pin || !/^[a-f0-9]{64}$/.test(pin.sha256) || !pin.url.includes(pin.version)) throw new Error(`unconfigured release tool: ${name}`);
        const url = new URL(pin.url);
        required.add(`${url.hostname}:${url.port || 443}`);
        use("github-release");
      }
    }
    for (const [literal] of command.matchAll(/https?:\/\/[a-z0-9.-]+(?::\d+)?/g)) {
      const url = new URL(literal);
      if (!["localhost", "127.0.0.1"].includes(url.hostname)) required.add(`${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`);
    }
  }
  return required;
}

export function allowedEndpoints(job) {
  const input = job.steps.find((step) => step.with?.["egress-policy"] === "block").with["allowed-endpoints"] ?? "";
  // The pinned harden-runner/agent splits on spaces, not arbitrary whitespace.
  const expressions = [];
  return input.trim().replace(/\$\{\{[^}]+\}\}/g, (expression) => `EXPR${expressions.push(expression) - 1}`)
    .split(" ").filter(Boolean).map((entry) => {
      if (!/^(?:[a-z0-9*.-]+|EXPR\d+):\d+$/.test(entry)) throw new Error(`invalid egress endpoint: ${entry}`);
      return entry.replace(/EXPR(\d+)/, (_, index) => expressions[index]);
    });
}

export function endpointProblems(job) {
  const required = requiredEndpoints(job), allowed = allowedEndpoints(job);
  return {
    missing: [...required].filter((endpoint) => !allowed.includes(endpoint)).sort(),
    unused: allowed.filter((endpoint) => !required.has(endpoint)).sort(),
  };
}
