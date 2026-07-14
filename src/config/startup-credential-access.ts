import { e2eConfigOnlyCredentialsRequested } from "./e2e-credential-mode.js";

/**
 * Executable startup credential policy.
 *
 * Keeping the policy in a side-effect-free module lets offline tests prove
 * that config-only Bridge E2E startup cannot invoke migration or any OS
 * keychain reader. The config-only mailbox callback is deliberately separate:
 * production binds it to loadCredentialsFromConfigFile().
 */
export class StartupCredentialAccess {
  readonly configOnly: boolean;

  constructor(env: NodeJS.ProcessEnv, configPath: string) {
    this.configOnly = e2eConfigOnlyCredentialsRequested(env, configPath);
  }

  async migrate(reader: () => Promise<boolean>): Promise<boolean> {
    return this.configOnly ? false : reader();
  }

  async readExternal<T>(reader: () => Promise<T>): Promise<T | null> {
    return this.configOnly ? null : reader();
  }

  async readMailbox<T>(readConfigFile: () => Promise<T>, readNormal: () => Promise<T>): Promise<T> {
    return this.configOnly ? readConfigFile() : readNormal();
  }
}
