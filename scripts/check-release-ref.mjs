#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { validateReleaseRef } from "./lib/release-ref.mjs";

const tag = process.argv[2] ?? process.env.MAILPOUCH_RELEASE_TAG;
if (!tag || !/^v[0-9A-Za-z.-]+$/.test(tag)) {
  throw new Error("Usage: node scripts/check-release-ref.mjs v<package-version>");
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const headSha = git("rev-parse", "HEAD");
const tagSha = git("rev-list", "-n", "1", `refs/tags/${tag}`);

validateReleaseRef({ tag, version: pkg.version, headSha, tagSha });
process.stdout.write(`release-ref OK: ${tag} -> ${headSha}\n`);
