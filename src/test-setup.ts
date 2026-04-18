/**
 * Vitest global setup.
 *
 * The TLS hardening in April 2026 made allowInsecureBridge a required opt-in
 * for localhost Bridge connections without a pinned cert. Existing tests were
 * written before that change and mock imapflow / nodemailer, so they never
 * exercise real TLS. Set the env-var opt-in globally so those tests can keep
 * calling connect()/initializeTransporter() without threading the flag through
 * every call site. Tests that verify the throw-on-missing-cert behavior
 * override this in their own setup.
 */
process.env.MAILPOUCH_INSECURE_BRIDGE = "1";
