import { isAbsolute, join } from "node:path";
import { buildPermissions } from "../../../src/config/loader.js";
import { isRunToken } from "./scratch.js";

/**
 * Runtime files touched during module initialization, before --settings-only
 * reaches its early return. Every path must stay inside this run's private
 * directory so the regression test cannot read or overwrite operator state.
 */
export const SETTINGS_ONLY_RUNTIME_FILES = {
  MAILPOUCH_AGENTS: "agents.json",
  MAILPOUCH_AGENT_AUDIT: "agent-audit.jsonl",
  MAILPOUCH_AUDIT: "audit.jsonl",
  MAILPOUCH_FTS_DB: "fts.db",
  MAILPOUCH_LOCK_PATH: "singleton.lock",
  MAILPOUCH_LOG_FILE: "mailpouch.log",
  MAILPOUCH_OAUTH_TOKENS: "oauth-tokens.json",
  MAILPOUCH_PASS_AUDIT: "pass-audit.jsonl",
  MAILPOUCH_PENDING: "pending.json",
  MAILPOUCH_REMINDERS: "reminders.json",
  MAILPOUCH_SCHEDULER_STORE: "scheduler.json",
  MAILPOUCH_SERVICE_ACCOUNTS: "service-accounts.json",
} as const;

const INHERITED_MAILPOUCH_OVERRIDES = [
  ...Object.keys(SETTINGS_ONLY_RUNTIME_FILES),
  "MAILPOUCH_CONFIG",
  "MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS",
  "MAILPOUCH_E2E_CREDENTIAL_TOKEN",
  "MAILPOUCH_E2E_RUN_TOKEN",
  "MAILPOUCH_FORCE_STDIO",
  "MAILPOUCH_INSECURE_BRIDGE",
  "MAILPOUCH_NO_SINGLETON",
  "MAILPOUCH_SMTP_ALLOW_PLAINTEXT",
  "MAILPOUCH_SMTP_FROM",
  "MAILPOUCH_TEST_DEFAULT_PROFILE_PATH",
  "MAILPOUCH_TEST_PATH",
  "MAILPOUCH_TEST_RUNTIME_PATH",
  "MAILPOUCH_TRUST_LOCAL",
] as const;

function sanitizedChildEnvironment(base: NodeJS.ProcessEnv): Record<string, string> {
  const childEnv: Record<string, string> = Object.fromEntries(
    Object.entries(base).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

  // A lifecycle regression child needs only the local process environment.
  // Never forward registry, cloud, signing-agent, or generic secret variables.
  for (const name of Object.keys(childEnv)) {
    if (/^(?:GH_TOKEN|GITHUB_TOKEN|NODE_AUTH_TOKEN|NPM_TOKEN|SSH_AUTH_SOCK|GPG_AGENT_INFO|GIT_ASKPASS|SSH_ASKPASS|DOCKER_CONFIG|KUBECONFIG|CI_JOB_JWT)$/i.test(name)
      || /^(?:AWS|AZURE|GOOGLE|GCP)_/i.test(name)
      || /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIALS?)$/i.test(name)) {
      delete childEnv[name];
    }
  }
  for (const name of Object.keys(childEnv)) {
    if (name.startsWith("MAILPOUCH_E2E_")) delete childEnv[name];
  }
  for (const name of INHERITED_MAILPOUCH_OVERRIDES) delete childEnv[name];
  return childEnv;
}

export interface SettingsOnlyIsolation {
  credentialToken: string;
  configPath: string;
  stateRoot: string;
  config: {
    configVersion: number;
    settingsPort: number;
    connection: {
      smtpHost: string;
      smtpPort: number;
      imapHost: string;
      imapPort: number;
      username: string;
      password: string;
      smtpToken: string;
      bridgeCertPath: string;
      allowInsecureBridge: boolean;
      autoStartBridge: boolean;
      tlsMode: "starttls";
      simpleloginApiKey: string;
      passAccessToken: string;
    };
    permissions: ReturnType<typeof buildPermissions>;
    credentialStorage: "config";
    keychainMailboxCredentialsQuarantined: true;
    keychainAuxiliaryCredentialsQuarantined: {
      passAccessToken: true;
      simpleloginApiKey: true;
    };
    requireDestructiveConfirm: true;
  };
  env: Record<string, string>;
}

/**
 * Build a credential-free settings-only child profile.
 *
 * The production config-only gate currently names disposable non-Bridge
 * profiles with the Greenmail basename. This test uses that exact basename and
 * matching UUID token even though it never opens a Greenmail connection.
 */
export function buildSettingsOnlyIsolation(
  baseEnv: NodeJS.ProcessEnv,
  home: string,
  port: number,
  credentialToken: string,
): SettingsOnlyIsolation {
  if (!isAbsolute(home)) throw new Error("Settings-only E2E home must be an absolute path");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Settings-only E2E port must be an integer between 1 and 65535");
  }
  if (!isRunToken(credentialToken)) {
    throw new Error("Settings-only E2E credential token must be an exact mpE2E UUIDv4 token");
  }

  const stateRoot = join(home, `.mailpouch-e2e-state-${credentialToken}`);
  const configPath = join(stateRoot, `.mailpouch-e2e-greenmail-${credentialToken}.json`);
  const env = sanitizedChildEnvironment(baseEnv);
  for (const [name, basename] of Object.entries(SETTINGS_ONLY_RUNTIME_FILES)) {
    env[name] = join(stateRoot, basename);
  }
  env.MAILPOUCH_CONFIG = configPath;
  env.MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS = "1";
  env.MAILPOUCH_E2E_CREDENTIAL_TOKEN = credentialToken;
  env.MAILPOUCH_TIER = "complete";

  return {
    credentialToken,
    configPath,
    stateRoot,
    config: {
      configVersion: 3,
      settingsPort: port,
      connection: {
        smtpHost: "127.0.0.1",
        smtpPort: 1,
        imapHost: "127.0.0.1",
        imapPort: 1,
        username: `settings-only-${credentialToken}`,
        // The lifecycle test never authenticates. Keeping these empty also
        // means a future credential-policy regression has no test password to
        // migrate into the operator's keychain.
        password: "",
        smtpToken: "",
        bridgeCertPath: "",
        allowInsecureBridge: false,
        autoStartBridge: false,
        tlsMode: "starttls",
        simpleloginApiKey: "",
        passAccessToken: "",
      },
      permissions: buildPermissions("full"),
      credentialStorage: "config",
      // AccountManager and auxiliary clients have their own hydration paths;
      // both durable quarantines are required in addition to startup policy.
      keychainMailboxCredentialsQuarantined: true,
      keychainAuxiliaryCredentialsQuarantined: {
        passAccessToken: true,
        simpleloginApiKey: true,
      },
      requireDestructiveConfirm: true,
    },
    env,
  };
}
