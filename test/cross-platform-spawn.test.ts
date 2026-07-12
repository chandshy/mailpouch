import { describe, expect, it } from "vitest";
import { resolveShellFreeLaunch, terminateProcessTree } from "../scripts/lib/cross-platform-spawn.mjs";

describe("cross-platform shell-free command resolution", () => {
  const execPath = "C:\\node\\node.exe";
  const npmCli = "C:\\node\\node_modules\\npm\\bin\\npm-cli.js";
  const npxCli = "C:\\node\\node_modules\\npm\\bin\\npx-cli.js";
  const existing = new Set([npmCli, npxCli]);
  const options = {
    platform: "win32",
    execPath,
    env: { npm_execpath: npmCli },
    fileExists: (candidate: string) => existing.has(candidate),
  };

  it("runs node through the current executable rather than a nonexistent node.cmd", () => {
    expect(resolveShellFreeLaunch("node", ["--version"], options)).toEqual({
      command: execPath,
      args: ["--version"],
    });
  });

  it("runs npm and npx JavaScript CLIs through Node without cmd.exe", () => {
    expect(resolveShellFreeLaunch("npm", ["--version"], options)).toEqual({
      command: execPath,
      args: [npmCli, "--version"],
    });
    expect(resolveShellFreeLaunch("npx", ["--version"], options)).toEqual({
      command: execPath,
      args: [npxCli, "--version"],
    });
  });

  it("fails closed when a Windows npm CLI cannot be resolved", () => {
    expect(() => resolveShellFreeLaunch("npm", ["--version"], {
      ...options,
      env: {},
      fileExists: () => false,
    })).toThrow(/Could not locate npm's JavaScript CLI/);
  });

  it("leaves unrelated executables and argv boundaries unchanged", () => {
    expect(resolveShellFreeLaunch("git", ["status", "argument with spaces"], options)).toEqual({
      command: "git",
      args: ["status", "argument with spaces"],
    });
  });

  it("uses shell-free taskkill tree termination with a numeric Windows PID", () => {
    const calls: unknown[][] = [];
    const child = { pid: 4321, kill: () => false };
    const terminated = terminateProcessTree(child, {
      platform: "win32",
      force: true,
      env: { SystemRoot: "C:\\Windows" },
      spawnSyncImpl: (...args: unknown[]) => {
        calls.push(args);
        return { status: 0 };
      },
    });

    expect(terminated).toBe(true);
    expect(calls).toEqual([[
      "C:\\Windows\\System32\\taskkill.exe",
      ["/PID", "4321", "/T", "/F"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    ]]);
  });

  it("signals the detached POSIX process group rather than only its leader", () => {
    const signals: Array<[number, string]> = [];
    const child = { pid: 2468, kill: () => false };
    expect(terminateProcessTree(child, {
      platform: "linux",
      killImpl: (pid: number, signal: string) => { signals.push([pid, signal]); },
    })).toBe(true);
    expect(signals).toEqual([[-2468, "SIGTERM"]]);
  });
});
