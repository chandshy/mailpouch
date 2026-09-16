/**
 * Escapers for text interpolated into the scripts the desktop notifier and
 * approval dialog hand to osascript / PowerShell. The text can be
 * attacker-chosen (a DCR client_name), so these are the injection boundary.
 */

/** Control chars have no place in a dialog or toast and can break out of a clause. */
function stripControl(s: string): string {
  return (s ?? "").replace(/[\x00-\x1f\x7f]/g, " ");
}

/** AppleScript double-quoted literal. */
export function escAppleScript(s: string): string {
  return stripControl(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * PowerShell single-quoted literal. PowerShell accepts U+2018–U+201B as
 * single-quote delimiters too, so every one of them is doubled — doubling only
 * ASCII `'` lets `’);Start-Process calc;(‘` close the literal and run code.
 */
export function escPowerShell(s: string): string {
  return stripControl(s).replace(/['‘’‚‛]/g, "$&$&");
}
