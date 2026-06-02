import { describe, it, expect, vi } from "vitest";
import { DesktopPrompt } from "./desktop-prompt.js";

/** A runner stub that records calls and returns scripted exit codes. */
function stub(codes: number[] | number) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let i = 0;
  const seq = Array.isArray(codes) ? codes : [codes];
  const runner = vi.fn(async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return seq[Math.min(i++, seq.length - 1)];
  });
  return { runner, calls };
}

describe("DesktopPrompt", () => {
  it("maps exit 0 → approve, 1 → deny, else → unavailable (linux/zenity)", async () => {
    for (const [code, expected] of [[0, "approve"], [1, "deny"], [5, "unavailable"], [-2, "unavailable"]] as const) {
      const { runner, calls } = stub(code);
      const p = new DesktopPrompt({ platform: "linux", runner });
      expect(await p.prompt({ title: "T", message: "M" })).toBe(expected);
      expect(calls[0].cmd).toBe("zenity");
      expect(calls[0].args).toContain("--question");
      expect(calls[0].args).toContain("--ok-label=Approve");
    }
  });

  it("linux falls back to kdialog only when zenity is missing (-1), not on a real answer", async () => {
    // zenity missing (-1) → try kdialog (0 = approve)
    const a = stub([-1, 0]);
    const pa = new DesktopPrompt({ platform: "linux", runner: a.runner });
    expect(await pa.prompt({ title: "T", message: "M" })).toBe("approve");
    expect(a.calls.map(c => c.cmd)).toEqual(["zenity", "kdialog"]);

    // zenity answered deny (1) → do NOT fall back
    const b = stub([1, 0]);
    const pb = new DesktopPrompt({ platform: "linux", runner: b.runner });
    expect(await pb.prompt({ title: "T", message: "M" })).toBe("deny");
    expect(b.calls.map(c => c.cmd)).toEqual(["zenity"]);
  });

  it("macOS uses osascript display dialog with Approve as the default button", async () => {
    const { runner, calls } = stub(0);
    const p = new DesktopPrompt({ platform: "darwin", runner });
    expect(await p.prompt({ title: "T", message: "M" })).toBe("approve");
    expect(calls[0].cmd).toBe("osascript");
    expect(calls[0].args.join(" ")).toContain('default button "Approve"');
  });

  it("windows uses a PowerShell Yes/No MessageBox", async () => {
    const { runner, calls } = stub(1);
    const p = new DesktopPrompt({ platform: "win32", runner });
    expect(await p.prompt({ title: "T", message: "M" })).toBe("deny");
    expect(calls[0].cmd).toBe("powershell.exe");
    expect(calls[0].args.join(" ")).toContain("MessageBox");
  });

  it("unsupported platform → unavailable", async () => {
    const { runner } = stub(0);
    const p = new DesktopPrompt({ platform: "freebsd" as NodeJS.Platform, runner });
    expect(await p.prompt({ title: "T", message: "M" })).toBe("unavailable");
  });
});
