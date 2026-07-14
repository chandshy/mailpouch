/**
 * Account-aware connection-edit helpers shared by both terminal UI modes.
 *
 * The legacy `connection` block is only a compatibility mirror once the
 * account registry exists.  Keeping this small boundary separate from the
 * interactive renderer makes the ownership rule easy to test and prevents
 * either TUI mode from accidentally writing credentials through saveConfig.
 */

import { readRegistry, updateAccount } from "../accounts/registry.js";
import type { AccountSpec } from "../accounts/types.js";

/** Fields the legacy TUI connection form is allowed to change on an account. */
export type ConnectionEditPatch = Partial<Pick<
  AccountSpec,
  "username" | "password" | "smtpHost" | "smtpPort" | "imapHost" | "imapPort" | "bridgeCertPath"
>>;

/** Resolve the account displayed by the connection-edit form. */
export function activeAccountForConnectionEdit(): AccountSpec {
  const registry = readRegistry();
  const account = registry.accounts.find(a => a.id === registry.activeAccountId);
  if (!account) {
    throw new Error("The active account no longer exists. Re-open the connection editor and try again.");
  }
  return account;
}

/** Persist a terminal connection edit through the keychain-aware registry. */
export async function saveActiveAccountConnectionEdit(
  accountId: string,
  patch: ConnectionEditPatch,
): Promise<AccountSpec> {
  const updated = await updateAccount(accountId, patch);
  if (!updated) {
    throw new Error("The account was removed while its settings were being edited. No changes were saved.");
  }
  return updated;
}
