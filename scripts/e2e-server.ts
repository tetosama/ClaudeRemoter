import { rm } from "node:fs/promises";

const dataDir = "/tmp/claude-remoter-e2e";
await rm(dataDir, { recursive: true, force: true });
process.env.CLAUDE_REMOTER_DATA_DIR = dataDir;
process.env.CLAUDE_REMOTER_PASSWORD = "playwright-test-password";
process.env.CLAUDE_REMOTER_PORT = "9443";
process.env.CLAUDE_REMOTER_HOST = "127.0.0.1";
process.env.CLAUDE_REMOTER_PROJECT_ROOT = "/tmp";
process.env.NODE_ENV = "development";
await import("./setup.js");
await import("../src/server/index.js");
