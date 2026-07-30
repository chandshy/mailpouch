#!/usr/bin/env node
// Pack the package as it would be published, install it into a clean temp
// directory, execute every published bin with `--version`, and exercise the
// published improvement-loop scripts. Catches:
//   - missing `bin` entry / wrong shebang / wrong mode
//   - files omitted from `files` (e.g. `dist/index.js` not shipped)
//   - ESM/CJS mismatch that boots locally but fails on a fresh install
//
// Exit 0 — installed bins and package scripts work from the tarball.
// Exit 1 — packing, installation, an installed entrypoint, or a script fails.

import { mkdtemp, rm, readFile, copyFile } from "node:fs/promises";
import { existsSync, openSync, closeSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnShellFree } from "./lib/cross-platform-spawn.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf-8"));
const PKG_VERSION = pkg.version;

// 1. Pack into a temp dir to avoid polluting ROOT with .tgz artifacts.
const stagingDir = await mkdtemp(join(tmpdir(), "preship-pack-"));
const installDir = await mkdtemp(join(tmpdir(), "preship-smoke-"));
let exitCode = 0;
try {
  const packRes = await runNpm(["pack", "--pack-destination", stagingDir, "--silent", "--json"], {
    cwd: ROOT,
    extraArgs: ["--ignore-scripts"],
  });
  // BUILD-007: every early-exit path throws so the catch/finally below runs
  // the staging/install cleanup and the single `exitCode` accumulator owns the
  // process exit code — no bare `process.exit(1)` that skips cleanup.
  if (packRes.error || packRes.status !== 0) {
    throw new Error(`npm pack failed (exit ${packRes.status}, signal ${packRes.signal ?? "none"}): ${packRes.error?.message || packRes.stderr || packRes.stdout}`);
  }
  let packReport;
  try {
    const parsed = JSON.parse(packRes.stdout);
    packReport = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (error) {
    throw new Error(`npm pack returned invalid JSON metadata: ${error.message}`);
  }
  const tgzName = packReport?.filename;
  if (typeof tgzName !== "string" || !tgzName) throw new Error("npm pack produced no tarball filename");
  const tgzPath = join(stagingDir, tgzName);
  if (!existsSync(tgzPath)) {
    throw new Error(`Tarball missing: ${tgzPath}`);
  }

  // The tarball itself must carry the executable bit on every bin target.
  // npm <= 10 silently chmod +x'ed bin targets at install (masking a 0644
  // tarball on those runners); npm 11 stopped, breaking `npx <pkg>` on every
  // fresh POSIX install. Inspect the archive, not the installed tree, so any
  // npm version catches the regression. `tar` ships on all CI runners.
  const tarList = spawnSync("tar", ["-tvzf", tgzPath], { encoding: "utf-8", timeout: 60_000 });
  if (tarList.error || tarList.status !== 0) {
    throw new Error(`tar -tvzf ${tgzName} failed: ${tarList.error?.message || tarList.stderr}`);
  }
  for (const target of Object.values(pkg.bin)) {
    const entry = tarList.stdout.split("\n").find((line) => line.endsWith(`package/${target}`));
    if (!entry) throw new Error(`Tarball is missing bin target package/${target}`);
    const modeField = entry.trimStart().split(/\s+/)[0];
    if (!/^-..x/.test(modeField)) {
      throw new Error(
        `Tarball bin target package/${target} is not executable (${modeField}); ` +
        `run \`npm run build\` so scripts/fix-bin-modes.mjs sets 0755 before packing`,
      );
    }
  }

  // 2. Install the tarball into a fresh dir. `--no-package-lock` keeps the
  //    install lean; `--omit=optional` avoids architecture-specific native
  //    deps that aren't installable on every runner.
  const installRes = await runNpm(
    [
      "install",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "--prefix", installDir,
      "--omit=optional",
      tgzPath,
    ],
    { timeout: 300_000, extraArgs: ["--ignore-scripts"] }
  );
  if (installRes.error || installRes.status !== 0) {
    throw new Error(`npm install <tarball> failed (exit ${installRes.status}, signal ${installRes.signal ?? "none"}): ${installRes.error?.message || installRes.stderr || installRes.stdout}`);
  }

  // 3. Verify the package entry exists, then execute every installed bin shim.
  //    Running dist/index.js directly only proves the source entry boots; it
  //    misses a broken `bin` mapping, lost shebang, or non-executable shim.
  const entry = join(installDir, "node_modules", pkg.name, pkg.main);
  if (!existsSync(entry)) {
    throw new Error(`Installed entry missing: ${entry}`);
  }

  const bins = typeof pkg.bin === "object" && pkg.bin !== null ? Object.keys(pkg.bin) : [];
  if (bins.length === 0) throw new Error("Package declares no bin shims to smoke-test");
  const binOutputs = [];
  for (const name of bins) {
    const shim = join(
      installDir,
      "node_modules",
      ".bin",
      process.platform === "win32" ? `${name}.cmd` : name,
    );
    if (!existsSync(shim)) throw new Error(`Installed bin shim missing: ${shim}`);
    const versionRes = spawnSync(shim, ["--version"], {
      encoding: "utf-8",
      timeout: 15_000,
      // Windows cannot execute a .cmd shim directly; on POSIX this remains a
      // direct exec, so it also catches a lost executable bit/shebang.
      shell: process.platform === "win32",
    });
    if (versionRes.error || versionRes.status !== 0) {
      throw new Error(`${name} --version failed (exit ${versionRes.status}): ${versionRes.error?.message || versionRes.stderr || versionRes.stdout}`);
    }
    const out = (versionRes.stdout || "").trim();
    if (!out.includes(PKG_VERSION)) {
      throw new Error(`${name} --version output did not contain ${PKG_VERSION}: got "${out}"`);
    }
    binOutputs.push(`${name}=${out}`);
  }

  // The tarball itself must carry the executable bit on every bin target:
  // npm 11 (Node 24) no longer chmods bin targets at install, so a 0644
  // target in the tarball breaks `npx <pkg>` on fresh POSIX installs even
  // though npm <= 10 test runners silently repair it and pass the shim exec
  // above. Assert the installed target mode directly.
  if (process.platform !== "win32") {
    const { statSync } = await import("node:fs");
    for (const target of Object.values(pkg.bin)) {
      const installedTarget = join(installDir, "node_modules", pkg.name, target);
      const mode = statSync(installedTarget).mode & 0o111;
      if (mode === 0) {
        throw new Error(
          `Installed bin target ${target} is not executable (tarball must ship 0755; see scripts/fix-bin-modes.mjs)`,
        );
      }
    }
  }

  // The improvement commands are published in package.json, so verify the
  // runner is present and usable from the installed package rather than only
  // from the source checkout. The generated state stays inside installDir and
  // is removed by the existing finally block.
  const installedPackageDir = join(installDir, "node_modules", pkg.name);
  const initLoopRes = await runNpm(["run", "--silent", "improve", "--", "init"], {
    cwd: installedPackageDir,
    timeout: 15_000,
  });
  if (initLoopRes.error || initLoopRes.status !== 0) {
    throw new Error(
      `installed npm run improve -- init failed (exit ${initLoopRes.status}, signal ${initLoopRes.signal ?? "none"}): ${initLoopRes.error?.message || initLoopRes.stderr || initLoopRes.stdout}`
    );
  }
  const loopSnapshot = join(installedPackageDir, ".improvement-loop", "snapshot.json");
  if (!existsSync(loopSnapshot)) {
    throw new Error(`Installed improvement loop did not create its snapshot: ${loopSnapshot}`);
  }

  const loopStatusRes = await runNpm(
    ["run", "--silent", "improve:status", "--", "--json"],
    { cwd: installedPackageDir, timeout: 15_000 },
  );
  if (loopStatusRes.error || loopStatusRes.status !== 0) {
    throw new Error(
      `installed npm run improve:status failed (exit ${loopStatusRes.status}, signal ${loopStatusRes.signal ?? "none"}): ${loopStatusRes.error?.message || loopStatusRes.stderr || loopStatusRes.stdout}`
    );
  }
  try {
    const status = JSON.parse(loopStatusRes.stdout);
    if (!status || typeof status !== "object" || !status.counts || typeof status.counts.queued !== "number") {
      throw new Error("status output is missing numeric backlog counts");
    }
  } catch (error) {
    throw new Error(`installed improve:status returned invalid JSON: ${error.message}`);
  }

  // 4. Verify packed files include the native-tray JS shim (BUILD-006). The
  //    --version path short-circuits before tray load, so we can't rely on
  //    "it booted" to prove the tray shim shipped. Probe the tar listing
  //    directly from npm pack's JSON metadata: the published tarball must
  //    contain native/tray/index.js. This avoids requiring an external `tar`
  //    executable on otherwise-supported Windows development machines.
  //    Failure paths here `throw` so the existing catch/finally chain runs
  //    the staging/install cleanup (BUILD-007: all early-exit branches above
  //    now `throw` too, so cleanup always runs).
  const REQUIRED_PACKED_FILES = [
    "package/native/tray/index.js",
    "package/native/tray/index.d.ts",
    "package/dist/index.js",
    "package/dist/settings-main.js",
    "package/dist/utils/tray.js",
    "package/scripts/improvement-loop.mjs",
    "package/scripts/lib/cross-platform-spawn.mjs",
  ];
  const packedFiles = new Set(
    (Array.isArray(packReport?.files) ? packReport.files : [])
      .map(file => typeof file?.path === "string" ? `package/${file.path.replaceAll("\\", "/")}` : "")
      .filter(Boolean),
  );
  const missing = REQUIRED_PACKED_FILES.filter((p) => !packedFiles.has(p));
  if (missing.length > 0) {
    throw new Error(
      `tarball-smoke FAILED: required files missing from tarball: ${missing.join(", ")}`
    );
  }

  console.log(`tarball-smoke OK: ${tgzName} → ${binOutputs.join(", ")} (${REQUIRED_PACKED_FILES.length} required files present)`);
} catch (e) {
  console.error(`tarball-smoke threw: ${e.message}`);
  exitCode = 1;
} finally {
  await rm(stagingDir, { recursive: true, force: true });
  await rm(installDir, { recursive: true, force: true });
}
process.exit(exitCode);

function runNpm(args, options = {}) {
  return new Promise((resolve) => {
    const outPath = join(tmpdir(), `mailpouch-npm-out-${process.pid}-${Date.now()}.json`);
    const errPath = join(tmpdir(), `mailpouch-npm-err-${process.pid}-${Date.now()}.log`);
    const outFd = openSync(outPath, "w");
    const errFd = openSync(errPath, "w");
    const child = spawnShellFree("npm", [...args, ...(options.extraArgs ?? [])], {
      cwd: options.cwd,
      timeout: options.timeout,
      stdio: ["ignore", outFd, errFd],
    });
    child.on("error", (error) => {
      closeSync(outFd);
      closeSync(errFd);
      resolve({ error, status: 1, signal: null, stdout: "", stderr: "" });
    });
    child.on("close", (status, signal) => {
      closeSync(outFd);
      closeSync(errFd);
      const stdout = readFileSync(outPath, "utf8");
      const stderr = readFileSync(errPath, "utf8");
      rmSync(outPath, { force: true });
      rmSync(errPath, { force: true });
      resolve({ status, signal, stdout, stderr, error: null });
    });
  });
}
