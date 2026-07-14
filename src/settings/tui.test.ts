import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountSpec } from "../accounts/types.js";

const accountRegistry = vi.hoisted(() => ({
  readRegistry: vi.fn(),
  updateAccount: vi.fn(),
}));

vi.mock("../accounts/registry.js", () => accountRegistry);

import {
  activeAccountForConnectionEdit,
  saveActiveAccountConnectionEdit,
} from "./active-account-edit.js";

const personal: AccountSpec = {
  id: "personal",
  name: "Personal",
  providerType: "imap",
  smtpHost: "smtp.personal.example",
  smtpPort: 587,
  imapHost: "imap.personal.example",
  imapPort: 993,
  username: "personal@example.com",
  password: "",
};

const work: AccountSpec = {
  id: "work",
  name: "Work",
  providerType: "imap",
  smtpHost: "smtp.work.example",
  smtpPort: 587,
  imapHost: "imap.work.example",
  imapPort: 993,
  username: "work@example.com",
  password: "",
};

describe("TUI account connection edits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountRegistry.readRegistry.mockReturnValue({
      accounts: [personal, work],
      activeAccountId: work.id,
    });
    accountRegistry.updateAccount.mockResolvedValue(work);
  });

  it("uses the active registry account rather than the legacy connection mirror", () => {
    expect(activeAccountForConnectionEdit()).toBe(work);
  });

  it("routes form changes, including passwords, through the account registry writer", async () => {
    const patch = {
      username: "new-work@example.com",
      smtpHost: "smtp.new-work.example",
      password: "new-bridge-password",
    };

    await expect(saveActiveAccountConnectionEdit(work.id, patch)).resolves.toBe(work);

    expect(accountRegistry.updateAccount).toHaveBeenCalledWith(work.id, patch);
  });

  it("does not claim success when the account disappears during editing", async () => {
    accountRegistry.updateAccount.mockResolvedValue(null);

    await expect(saveActiveAccountConnectionEdit(work.id, { username: "new@example.com" }))
      .rejects.toThrow("The account was removed while its settings were being edited");
  });
});
