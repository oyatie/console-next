// SPDX-License-Identifier: LicenseRef-Proprietary
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Network contracts include redirects and cold-cache paths, even when a warm run skips them.
// Script subprocesses are discovered below: cargo metadata invokes rustup before Cargo starts.
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
  rustup: { run: /\b(?:rustup|rustc|cargo)(?:\s|$)/, endpoints: ["static.rust-lang.org:443"] },
  cargo: { run: /\bcargo\s+(?:fetch|build|clippy|check|test|nextest\s+archive)\b/, endpoints: ["index.crates.io:443", "static.crates.io:443"] },
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
  "ci-e2e": { run: /scripts\/ci\/e2e\.mjs\s+run\b/, needs: ["docker"] },
  "ci-cache-metrics": { env: { CI_CACHE_TOTAL: "1" }, needs: ["gh"] },
  probe: { env: { URL: "${{ secrets.PROBE_URL }}" }, endpoints: ["${{ secrets.CONSOLE_PUBLIC_HOST }}:443"] },
  sccache: { run: /\bsccache\b/, endpoints: [] }, // SCCACHE_DIR is local; actions/cache transfers it.
};

export function requiredEndpoints(job, root = fileURLToPath(new URL("../../", import.meta.url))) {
  const required = new Set();
  const visited = new Set();
  function use(name) {
    const tool = tools[name];
    if (!tool) throw new Error(`unmapped network tool: ${name}`);
    for (const dependency of tool.needs ?? []) use(dependency);
    for (const endpoint of tool.endpoints ?? []) required.add(endpoint);
  }
  function commands(command, step) {
    // Expand the checked-in npm/Node entrypoints; job names cannot describe their subprocesses.
    for (const [, name] of command.matchAll(/\bnpm\s+(?:run\s+([\w:-]+)|(test))\b/g)) {
      const script = name || "test";
      if (visited.has(`npm:${script}`)) continue;
      visited.add(`npm:${script}`);
      const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts;
      if (!scripts[script]) throw new Error(`unmapped npm script: ${script}`);
      commands(scripts[script], step);
    }
    for (const [, args] of command.matchAll(/\bnode\s+([^\n;&|]+)/g))
      for (const [file] of args.matchAll(/(?:\.\.\/|\.\/)?scripts\/[\w/.-]+\.m?js\b/g)) inspectScript(path.join(root, file.replace(/^\.\.\//, "")), step, false);
    for (const [, file] of command.matchAll(/\b(?:bash|sh|python3)\s+((?:\.\.\/|\.\/)?scripts\/[\w/.-]+\.(?:sh|py))\b/g)) {
      const relative = file.replace(/^\.\.\//, "");
      if (visited.has(relative)) continue;
      visited.add(relative);
      const source = readFileSync(path.join(root, relative), "utf8");
      if (file.endsWith(".sh")) commands(source, step);
      else for (const [, program] of source.matchAll(/\b(?:run|Popen|check_call|check_output|call)\(\s*\[\s*["'](cargo|rustc|rustup)["']/g)) commands(program, step);
    }
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
    for (const match of command.matchAll(/https?:\/\/[a-z0-9.-]+(?::\d+)?/g)) {
      // Shell configuration assignments (e.g. a compiled desktop origin) do not make requests.
      if (/(?:^|\s)[A-Za-z_]\w*=["']?$/.test(command.slice(0, match.index))) continue;
      const [literal] = match;
      const url = new URL(literal);
      if (!["localhost", "127.0.0.1"].includes(url.hostname)) required.add(`${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`);
    }
  }
  function inspectScript(script, step, imported) {
    const key = `${script}:${imported}`;
    if (visited.has(key)) return;
    visited.add(key);
    if (!existsSync(script)) throw new Error(`missing invoked script: ${path.relative(root, script)}`);
    const source = ts.createSourceFile(script, readFileSync(script, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node) {
      // Imported CLI modules do not execute their guarded main entrypoint.
      if (imported && ts.isIfStatement(node) && /process\.argv\[1\].*import\.meta\.url/.test(node.expression.getText(source))) return;
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith("."))
        inspectScript(path.resolve(path.dirname(script), node.moduleSpecifier.text), step, true);
      if (ts.isCallExpression(node) && /^(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)$/.test(node.expression.getText(source))) {
        const [program, args, options] = node.arguments;
        const name = program && ts.isStringLiteral(program) ? program.text : program?.getText(source) === "process.execPath" ? "node" : undefined;
        // CLI tests supply a synthetic PATH with local cargo/git stubs, not runner tools.
        const stubbed = /\.test\.mjs$/.test(script) && ["node", "bash", "python3"].includes(name) && options &&
          /\bPATH\s*:\s*`[^`\n]+:\$\{process\.env\.PATH(?:\s*\?\?[^}]+)?\}`/.test(options.getText(source));
        if (name && !stubbed) {
          const literals = args && ts.isArrayLiteralExpression(args) ? args.elements.filter(ts.isStringLiteral).map((arg) => arg.text) : [];
          // Cache metrics calls gh only when explicitly enabled for this step.
          if (name !== "gh" || (step.env?.CI_CACHE_TOTAL ?? job.env?.CI_CACHE_TOTAL) === "1") commands([name, ...literals].join(" "), step);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  for (const step of job.steps ?? []) {
    visited.clear();
    if (step.uses) use(step.uses.split("@")[0]);
    commands(step.run ?? "", step);
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
