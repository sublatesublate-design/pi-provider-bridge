import { homedir } from "node:os";
import { join } from "node:path";

/** All vendor filesystem paths are isolated from TUI and project state. */
export function agentDir(): string {
  return join(homedir(), ".pi-desktop", "plugins", "data", "local.pi-provider-bridge");
}

/** Path to Pi's credential file. Read-only for this extension. */
export function authJsonPath(): string {
  return join(agentDir(), "auth.json");
}

/** Path to Pi's global settings file. */
export function settingsJsonPath(): string {
  return join(agentDir(), "settings.json");
}

/** Path to project-local settings file. */
export function projectSettingsJsonPath(_cwd?: string): string {
  return join(agentDir(), "project-settings.json");
}
