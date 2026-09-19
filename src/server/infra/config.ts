// Loads, validates, and derives all runtime settings, paths, and secret redaction.
import { execFileSync } from "node:child_process";
import { homedir, hostname, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { access, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";

export interface StoredConfig {
  host: string;
  port: number;
  claudePath: string;
  projectRoot: string;
  localHostname: string;
  maxActiveSessions: number;
}

export interface StoredAuth {
  passwordSalt: string;
  passwordHash: string;
  sessionSecret: string;
}

export interface RuntimeConfig extends StoredConfig {
  dataDir: string;
  databasePath: string;
  uploadDir: string;
  logDir: string;
  claudeConfigDir: string;
  /** Sensitive settings retained in memory only so outbound payloads can redact exact values. */
  sensitiveValues: string[];
  auth: StoredAuth;
}

// Resolve the data directory, honoring the CLAUDE_REMOTER_DATA_DIR override.
export function getDataDir(): string {
  return resolve(process.env.CLAUDE_REMOTER_DATA_DIR || join(homedir(), ".claude-remoter"));
}

// Resolve the Bonjour hostname used to reach the server on the LAN.
// Only macOS resolves these names via mDNS out of the box; other platforms
// return the plain host name so the printed address stays reachable.
export function defaultLocalHostname(): string {
  try {
    const value = execFileSync("scutil", ["--get", "LocalHostName"], { encoding: "utf8" }).trim();
    if (value) return `${value}.local`;
  } catch {
    // Non-macOS development and test environments use the regular host name.
  }
  const value = hostname().replace(/[^a-zA-Z0-9.-]/g, "-");
  return process.platform === "darwin" && !value.endsWith(".local") ? `${value}.local` : value;
}

// Collect all non-internal IPv4 addresses of this machine.
export function localIpAddresses(): string[] {
  const values = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (!entry.internal && entry.family === "IPv4") values.add(entry.address);
    }
  }
  return [...values];
}

// Read, validate, and enrich config.json and auth.json into a runtime configuration.
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const dataDir = getDataDir();
  const configPath = join(dataDir, "config.json");
  const authPath = join(dataDir, "auth.json");
  try {
    const [configRaw, authRaw] = await Promise.all([
      readFile(configPath, "utf8"),
      readFile(authPath, "utf8"),
    ]);
    const parsedConfig = JSON.parse(configRaw) as Partial<StoredConfig>;
    const config = { ...parsedConfig } as StoredConfig;
    const auth = JSON.parse(authRaw) as StoredAuth;
    validateStoredConfig(config, auth);
    const projectRoot = await realpath(config.projectRoot);
    await access(config.claudePath, constants.X_OK);
    await mkdir(join(dataDir, "uploads"), { recursive: true, mode: 0o700 });
    await mkdir(join(dataDir, "logs"), { recursive: true, mode: 0o700 });
    const claudeConfigDir = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
    const uploadDir = join(dataDir, "uploads");
    return {
      ...config,
      projectRoot,
      auth,
      dataDir,
      databasePath: join(dataDir, "remoter.sqlite3"),
      uploadDir,
      logDir: join(dataDir, "logs"),
      claudeConfigDir,
      sensitiveValues: [uploadDir, ...await readSensitiveValues(claudeConfigDir)],
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Claude Remoter is not set up yet. Run npm run setup first. (${redactSecrets(reason)})`);
  }
}

// Check that required config fields and stored credentials are present and sane.
function validateStoredConfig(config: StoredConfig, auth: StoredAuth): void {
  if (!config || typeof config !== "object") throw new Error("Invalid config.json");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("Invalid port");
  for (const value of [config.claudePath, config.projectRoot]) {
    if (!value || !resolve(value).startsWith("/")) throw new Error("Config paths must be absolute");
  }
  if (!auth.passwordSalt || !auth.passwordHash || !auth.sessionSecret) throw new Error("Invalid auth.json");
}

// Pick the most user-friendly LAN address, preferring private IPv4 ranges.
export function preferredLanHost(localHostname: string, ips: readonly string[]): string {
  return ips.find(isPrivateIpv4) || ips[0] || localHostname;
}

// Test whether an address falls in a private or link-local IPv4 range.
function isPrivateIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 169 && parts[1] === 254);
}

// Ensure the given path exists and is a directory, returning its resolved form.
export async function assertDirectory(path: string): Promise<string> {
  const real = resolve(path);
  const info = await stat(real);
  if (!info.isDirectory()) throw new Error("Selected path is not a directory");
  return real;
}

// Replace known secrets and typical credential patterns with [REDACTED].
export function redactSecrets(value: string, exactValues: readonly string[] = []): string {
  let redacted = value;
  for (const secret of exactValues) {
    if (secret.length >= 4) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(/(sk|key|token|bearer)[-_a-z0-9]{8,}/gi, "[REDACTED]")
    .replace(/(ANTHROPIC_(?:AUTH_TOKEN|API_KEY)\s*[=:]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, "https://[REDACTED]@");
}

// Gather secret-looking values from the environment and Claude settings.
async function readSensitiveValues(claudeConfigDir: string): Promise<string[]> {
  const values = new Set<string>();
  const sensitiveKey = /(TOKEN|API_?KEY|SECRET|PASSWORD|BASE_?URL|ENDPOINT)/i;
  for (const [key, value] of Object.entries(process.env)) {
    if (sensitiveKey.test(key) && typeof value === "string" && value.length >= 4) values.add(value);
  }
  try {
    const settings = JSON.parse(await readFile(join(claudeConfigDir, "settings.json"), "utf8")) as {
      env?: Record<string, unknown>;
    };
    for (const [key, value] of Object.entries(settings.env || {})) {
      if (sensitiveKey.test(key) && typeof value === "string" && value.length >= 4) values.add(value);
    }
  } catch {
    // Invalid settings are reported by the model/session endpoints. Startup
    // still succeeds so the health endpoint remains useful for diagnosis.
  }
  return [...values].sort((a, b) => b.length - a.length);
}

// Check whether a candidate path is the root itself or lies beneath it.
export function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

// Return the resolved parent directory of a path.
export function parentDirectory(path: string): string {
  return dirname(resolve(path));
}
