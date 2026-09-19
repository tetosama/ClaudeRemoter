import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPathInside, preferredLanHost, redactSecrets } from "../../src/server/infra/config.js";

describe("configuration security", () => {
  it("prefers a private LAN address for phones", () => {
    expect(preferredLanHost("mac.local", ["100.64.0.2", "192.168.50.207"])).toBe("192.168.50.207");
    expect(preferredLanHost("mac.local", [])).toBe("mac.local");
  });

  it("rejects sibling and traversal paths", () => {
    expect(isPathInside("/Users/test", "/Users/test/project")).toBe(true);
    expect(isPathInside("/Users/test", "/Users/test-other/project")).toBe(false);
    expect(isPathInside("/Users/test", "/Users/test/project/../../secret")).toBe(false);
  });

  it("redacts credential-like values", () => {
    expect(redactSecrets("ANTHROPIC_AUTH_TOKEN=token-super-secret-value")).not.toContain("super-secret");
    expect(redactSecrets("https://alice:password@example.com/path")).not.toContain("password");
    expect(redactSecrets("gateway https://private.example/v1", ["https://private.example/v1"]))
      .toBe("gateway [REDACTED]");
  });

  it("detects a symlink that escapes the root after canonicalization", async () => {
    const base = await mkdtemp(join(tmpdir(), "remoter-path-"));
    const root = join(base, "root");
    const outside = join(base, "outside");
    await Promise.all([mkdir(root), mkdir(outside)]);
    await symlink(outside, join(root, "escape"));
    expect(isPathInside(await realpath(root), await realpath(join(root, "escape")))).toBe(false);
  });
});
