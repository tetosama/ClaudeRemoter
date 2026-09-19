import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { hashPassword, newSessionSecret } from "../src/server/infra/auth.js";
import {
  defaultLocalHostname,
  getDataDir,
  localIpAddresses,
  preferredLanHost,
  type StoredAuth,
  type StoredConfig,
} from "../src/server/infra/config.js";

const dataDir = getDataDir();
const configPath = join(dataDir, "config.json");
const authPath = join(dataDir, "auth.json");

await mkdir(join(dataDir, "uploads"), { recursive: true, mode: 0o700 });
await mkdir(join(dataDir, "logs"), { recursive: true, mode: 0o700 });
await chmod(dataDir, 0o700);

const localHostname = defaultLocalHostname();
const first = process.env.CLAUDE_REMOTER_PASSWORD || await readSecret("Set the access password (at least 10 characters): ");
const second = process.env.CLAUDE_REMOTER_PASSWORD || await readSecret("Repeat the access password: ");
if (first !== second) throw new Error("Passwords do not match");
const password = await hashPassword(first);
const auth: StoredAuth = { ...password, sessionSecret: newSessionSecret() };
await writePrivateJson(authPath, auth);

let previous: Partial<StoredConfig> = {};
try {
  previous = JSON.parse(await readFile(configPath, "utf8")) as Partial<StoredConfig>;
} catch {
  // First setup.
}

const config: StoredConfig = {
  host: process.env.CLAUDE_REMOTER_HOST || previous.host || "0.0.0.0",
  port: Number(process.env.CLAUDE_REMOTER_PORT || previous.port || 8443),
  claudePath: process.env.CLAUDE_PATH ? resolve(process.env.CLAUDE_PATH) : previous.claudePath || findClaude(),
  projectRoot: resolve(process.env.CLAUDE_REMOTER_PROJECT_ROOT || previous.projectRoot || homedir()),
  localHostname,
  maxActiveSessions: previous.maxActiveSessions || 3,
};
await writePrivateJson(configPath, config);

const displayHost = preferredLanHost(localHostname, localIpAddresses());
process.stdout.write(`\nSetup complete.\nOpen: http://${displayHost}:${config.port}\n`);
process.stdout.write("Run npm start, then open that address from a browser on your LAN.\n");

function findClaude(): string {
  const configured = process.env.CLAUDE_PATH;
  if (configured) return resolve(configured);
  try {
    return resolve(execFileSync("which", ["claude"], { encoding: "utf8" }).trim());
  } catch {
    throw new Error("Could not find the claude executable; set its path via CLAUDE_PATH");
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("Set CLAUDE_REMOTER_PASSWORD in non-interactive environments");
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return await new Promise<string>((resolveSecret, reject) => {
    let value = "";
    const onData = (chunk: string) => {
      if (chunk === "") {
        cleanup();
        reject(new Error("Cancelled"));
        return;
      }
      if (chunk === "\r" || chunk === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolveSecret(value);
        return;
      }
      if (chunk === "") value = value.slice(0, -1);
      else if (chunk >= " ") value += chunk;
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on("data", onData);
  });
}
