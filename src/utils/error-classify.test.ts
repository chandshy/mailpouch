import { describe, it, expect } from "vitest";
import { classifyError, isFolderNotFoundError } from "./error-classify.js";

describe("classifyError", () => {
  describe("not_found", () => {
    it("classifies imapflow NONEXISTENT responseText", () => {
      const err = Object.assign(new Error("Command failed"), {
        responseText: "NONEXISTENT Mailbox doesn't exist",
        responseStatus: "NO",
      });
      const c = classifyError(err, { folder: "Labels/X" });
      expect(c.category).toBe("not_found");
      expect(c.message).toBe("Folder/label 'Labels/X' not found.");
    });

    it("classifies textual \"Mailbox doesn't exist\"", () => {
      const c = classifyError(new Error("Mailbox doesn't exist"), { folder: "Foo" });
      expect(c.category).toBe("not_found");
      expect(c.message).toBe("Folder/label 'Foo' not found.");
    });

    it("classifies \"does not exist\" without context to a generic message", () => {
      const c = classifyError(new Error("Folder 'Bar' does not exist"));
      expect(c.category).toBe("not_found");
      expect(c.message).toBe("The requested folder or label was not found.");
    });

    it("matches a bare \"not found\" message", () => {
      expect(classifyError(new Error("Resource not found")).category).toBe("not_found");
    });
  });

  describe("auth", () => {
    it("classifies authenticationFailed flag", () => {
      const err = Object.assign(new Error("login failed"), { authenticationFailed: true });
      const c = classifyError(err);
      expect(c.category).toBe("auth");
      expect(c.message).toMatch(/authentication failed/i);
    });

    it("classifies AUTHENTICATIONFAILED code", () => {
      const err = Object.assign(new Error("nope"), { code: "AUTHENTICATIONFAILED" });
      expect(classifyError(err).category).toBe("auth");
    });

    it("classifies \"Invalid credentials\" text", () => {
      expect(classifyError(new Error("Invalid credentials")).category).toBe("auth");
    });

    it("classifies Proton Bridge's exact local-login rejections as auth", () => {
      for (const m of ["4 NO no such user", "454 4.7.0 invalid username or password", "Incorrect login credentials"]) {
        expect(classifyError(new Error(m)).category).toBe("auth");
      }
      // imapflow surfaces responseText on a shaped error too.
      const shaped = Object.assign(new Error("NO"), { responseText: "no such user" });
      expect(classifyError(shaped).category).toBe("auth");
    });

    it("classifies EAUTH code as auth", () => {
      expect(classifyError(Object.assign(new Error("Invalid login"), { code: "EAUTH" })).category).toBe("auth");
    });
  });

  describe("timeout", () => {
    it("classifies ETIMEDOUT code", () => {
      const err = Object.assign(new Error("socket hang"), { code: "ETIMEDOUT" });
      const c = classifyError(err);
      expect(c.category).toBe("timeout");
      expect(c.message).toMatch(/timed out/i);
    });

    it("classifies \"timed out\" message", () => {
      expect(classifyError(new Error("Operation timed out")).category).toBe("timeout");
    });
  });

  describe("connection", () => {
    it("classifies IMAPNotConnectedError by name", () => {
      const err = new Error("Cannot fetch: IMAP connection unavailable");
      err.name = "IMAPNotConnectedError";
      const c = classifyError(err);
      expect(c.category).toBe("connection");
      expect(c.message).toMatch(/connection to the mail server/i);
    });

    it("classifies ECONNRESET code", () => {
      const err = Object.assign(new Error("reset"), { code: "ECONNRESET" });
      expect(classifyError(err).category).toBe("connection");
    });

    it("classifies \"not connected\" message", () => {
      expect(classifyError(new Error("IMAP client not connected")).category).toBe("connection");
    });
  });

  describe("internal (fallthrough)", () => {
    it("classifies an unrecognised error as internal", () => {
      const c = classifyError(new Error("Something weird happened"));
      expect(c.category).toBe("internal");
      expect(c.message).toMatch(/internal error/i);
    });

    it("never leaks the raw message into the internal category", () => {
      const c = classifyError(new Error("SECRET stack trace line @user@host"));
      expect(c.message).not.toContain("SECRET");
    });

    it("handles non-Error thrown values", () => {
      expect(classifyError("a string").category).toBe("internal");
      expect(classifyError(undefined).category).toBe("internal");
      expect(classifyError(null).category).toBe("internal");
      expect(classifyError(42).category).toBe("internal");
    });
  });

  describe("priority ordering", () => {
    it("prefers not_found over connection when both keywords present", () => {
      // A NONEXISTENT rejection that also mentions "socket" must still be not_found.
      const err = Object.assign(new Error("NONEXISTENT (over socket)"), {
        responseText: "NONEXISTENT",
      });
      expect(classifyError(err).category).toBe("not_found");
    });
  });
});

describe("isFolderNotFoundError", () => {
  it("is true for a NONEXISTENT rejection", () => {
    const err = Object.assign(new Error("x"), { responseText: "NONEXISTENT" });
    expect(isFolderNotFoundError(err)).toBe(true);
  });

  it("is false for an auth failure", () => {
    const err = Object.assign(new Error("x"), { code: "AUTHENTICATIONFAILED" });
    expect(isFolderNotFoundError(err)).toBe(false);
  });

  it("is false for an unrelated internal error", () => {
    expect(isFolderNotFoundError(new Error("boom"))).toBe(false);
  });
});
