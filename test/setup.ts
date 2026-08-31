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
 *
 * TEST-010: this global default is convenient but does mean a NEW strict-mode
 * test silently inherits "1" and never exercises strict semantics. Any test
 * that wants the production strict default MUST clear the var in its own
 * `beforeEach`/`afterEach` (see `connect-tls.test.ts` → "strict mode" block for
 * the canonical pattern):
 *
 *     let prev: string | undefined;
 *     beforeEach(() => { prev = process.env.MAILPOUCH_INSECURE_BRIDGE; delete process.env.MAILPOUCH_INSECURE_BRIDGE; });
 *     afterEach(() => { if (prev !== undefined) process.env.MAILPOUCH_INSECURE_BRIDGE = prev; else delete process.env.MAILPOUCH_INSECURE_BRIDGE; });
 */
process.env.MAILPOUCH_INSECURE_BRIDGE = "1";
