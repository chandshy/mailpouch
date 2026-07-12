import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const NPM_CLI_BASENAME = /^npm-cli\.(?:c?js|mjs)$/i;

function pathApiFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function npmCliNames(command) {
  return command === "npm"
    ? ["npm-cli.js", "npm-cli.cjs", "npm-cli.mjs"]
    : ["npx-cli.js", "npx-cli.cjs", "npx-cli.mjs"];
}

function findNpmCli(command, { platform, execPath, env, fileExists }) {
  const pathApi = pathApiFor(platform);
  const names = npmCliNames(command);
  const candidates = [];
  const npmExecPath = env.npm_execpath;

  // npm exposes the exact CLI JavaScript path to every npm-run child. Reuse
  // that path instead of launching npm.cmd through cmd.exe on Windows. npx's
  // CLI lives beside npm-cli.js in supported npm distributions.
  if (typeof npmExecPath === "string" && NPM_CLI_BASENAME.test(pathApi.basename(npmExecPath))) {
    if (command === "npm") candidates.push(npmExecPath);
    else candidates.push(...names.map(name => pathApi.join(pathApi.dirname(npmExecPath), name)));
  }

  // Direct `node scripts/...` invocations do not have npm_execpath. Official
  // Node installers place npm below one of these two locations relative to the
  // Node executable (Windows beside node.exe; POSIX below ../lib).
  const nodeDirectory = pathApi.dirname(execPath);
  for (const name of names) {
    candidates.push(pathApi.join(nodeDirectory, "node_modules", "npm", "bin", name));
    candidates.push(pathApi.resolve(nodeDirectory, "..", "lib", "node_modules", "npm", "bin", name));
  }

  return candidates.find(candidate => fileExists(candidate));
}

/**
 * Resolve Node/npm/npx without a command shell.
 *
 * Windows cannot execute .cmd shims directly, while `shell: true` would turn
 * an audited argv array back into a shell-interpolated string. Running npm's
 * JavaScript CLI through the current Node executable preserves argv boundaries
 * on every supported platform.
 */
export function resolveShellFreeLaunch(command, args = [], options = {}) {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? existsSync;

  if (command === "node") {
    return { command: execPath, args: [...args] };
  }

  if (command === "npm" || command === "npx") {
    const cli = findNpmCli(command, { platform, execPath, env, fileExists });
    if (cli) return { command: execPath, args: [cli, ...args] };
    if (platform === "win32") {
      const error = new Error(
        `Could not locate ${command}'s JavaScript CLI for shell-free Windows execution. ` +
        "Run this command through npm or reinstall Node.js with npm included.",
      );
      error.code = "ENOENT";
      throw error;
    }
  }

  return { command, args: [...args] };
}

function withoutShell(options) {
  const safe = { ...options };
  delete safe.shell;
  return { ...safe, shell: false };
}

export function spawnShellFree(command, args = [], options = {}) {
  const launch = resolveShellFreeLaunch(command, args, { env: options.env });
  return spawn(launch.command, launch.args, withoutShell(options));
}

export function spawnShellFreeSync(command, args = [], options = {}) {
  const launch = resolveShellFreeLaunch(command, args, { env: options.env });
  return spawnSync(launch.command, launch.args, withoutShell(options));
}

/**
 * Terminate a spawned command and every descendant it created.
 *
 * POSIX callers must spawn the command with `detached: true`, making its PID a
 * new process-group ID; signaling the negative PID then reaches the full group.
 * Windows has no equivalent Node API, so use the built-in taskkill executable
 * with a numeric PID and `/T`. No command shell or interpolated command string
 * is involved on either platform.
 */
export function terminateProcessTree(child, options = {}) {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;

  const platform = options.platform ?? process.platform;
  const force = options.force === true;
  if (platform === "win32") {
    const env = options.env ?? process.env;
    const windowsPath = path.win32;
    const taskkill = typeof env.SystemRoot === "string" && env.SystemRoot
      ? windowsPath.join(env.SystemRoot, "System32", "taskkill.exe")
      : "taskkill.exe";
    const runSync = options.spawnSyncImpl ?? spawnSync;
    const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
    const result = runSync(taskkill, args, {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    if (!result?.error && result?.status === 0) return true;
  } else {
    const signal = force ? "SIGKILL" : "SIGTERM";
    const kill = options.killImpl ?? process.kill.bind(process);
    try {
      kill(-pid, signal);
      return true;
    } catch {
      // If process-group signaling is unavailable, still terminate the direct
      // child below. The regression suite ensures supported POSIX hosts take
      // the group path and do not leave descendants behind.
    }
  }

  try {
    return child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    return false;
  }
}
