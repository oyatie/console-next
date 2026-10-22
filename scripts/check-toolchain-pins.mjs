#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
// Pinned toolchain check: enforces single stable Rust toolchain pin across the monorepo.
//   1. Root rust-toolchain.toml holds the stable channel with a written reason.
//   2. Sub-crates (backend/, apps/desktop/) drop theirs or equal the root pin.
//   3. backend/fuzz nightly pin stays, named with its written reason.
//   4. Any mismatched or unauthorized pin fails the check.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseToolchainFile(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf8");
  const channelMatch = content.match(/channel\s*=\s*"([^"]+)"/);
  const channel = channelMatch ? channelMatch[1] : null;

  // Extract comments as the written reason
  const comments = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("#"))
    .map((l) => l.replace(/^#+\s*/, ""))
    .join(" ")
    .trim();

  return {
    path: filePath,
    channel,
    reason: comments,
    raw: content,
  };
}

export function findToolchainFiles(dir, fileList = []) {
  if (!existsSync(dir)) return fileList;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git" || entry === "target" || entry === "dist" || entry === ".cache") {
      continue;
    }
    const full = path.join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        findToolchainFiles(full, fileList);
      } else if (entry === "rust-toolchain.toml" || entry === "rust-toolchain") {
        fileList.push(full);
      }
    } catch {
      // Ignore unreadable entries
    }
  }
  return fileList;
}

export function checkToolchainPins(rootDir) {
  const problems = [];
  const rootToolchainPath = path.join(rootDir, "rust-toolchain.toml");
  const rootParsed = parseToolchainFile(rootToolchainPath);

  if (!rootParsed) {
    problems.push(`root rust-toolchain.toml is missing: repo root must hold the stable Rust toolchain pin`);
    return problems;
  }

  if (!rootParsed.channel) {
    problems.push(`root rust-toolchain.toml has no channel pin in [toolchain]`);
  } else if (rootParsed.channel.startsWith("nightly")) {
    problems.push(`root rust-toolchain.toml pins ${rootParsed.channel}: root must hold a stable channel`);
  }

  if (!rootParsed.reason || rootParsed.reason.length < 10) {
    problems.push(`root rust-toolchain.toml has no written reason explaining why channel ${rootParsed.channel} was chosen`);
  }

  const expectedStable = rootParsed.channel;

  // Find all toolchains in the tree
  const allToolchains = findToolchainFiles(rootDir).map((f) => path.relative(rootDir, f).split(path.sep).join("/"));

  for (const rel of allToolchains) {
    if (rel === "rust-toolchain.toml" || rel === "rust-toolchain") {
      continue; // Checked as root
    }

    const full = path.join(rootDir, rel);
    const parsed = parseToolchainFile(full);
    if (!parsed) continue;

    // backend/fuzz is an authorized nightly pin
    if (rel === "backend/fuzz/rust-toolchain.toml") {
      if (!parsed.channel || !parsed.channel.startsWith("nightly")) {
        problems.push(`${rel} must pin nightly for libFuzzer/sanitizers; found ${parsed.channel}`);
      }
      if (!parsed.reason || !/(sanitizer|sancov|fuzz|libFuzzer)/i.test(parsed.reason)) {
        problems.push(`${rel} nightly pin must state why nightly is needed (sanitizer/sancov/libFuzzer)`);
      }
      continue;
    }

    // Any other toolchain file must equal the root stable channel
    if (parsed.channel !== expectedStable) {
      problems.push(
        `${rel} pins "${parsed.channel}" but root rust-toolchain.toml pins "${expectedStable}": sub-crates must drop their toolchain file or equal the root pin`,
      );
    }
  }

  return problems;
}

// Direct CLI execution (e.g. node scripts/check-toolchain-pins.mjs --check)
if (process.argv[2] === "--check") {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const problems = checkToolchainPins(root);
  if (problems.length) {
    process.stderr.write(`check-toolchain-pins: ${problems.length} problem(s):\n${problems.join("\n")}\n`);
    process.exit(1);
  } else {
    process.stdout.write("check-toolchain-pins: PASS\n");
    process.exit(0);
  }
}

