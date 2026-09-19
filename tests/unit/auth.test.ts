import { describe, expect, it } from "vitest";
import { createSessionToken, hashPassword, newSessionSecret, verifyPassword, verifySessionToken } from "../../src/server/infra/auth.js";

describe("auth", () => {
  it("hashes passwords and verifies without retaining plaintext", async () => {
    const password = await hashPassword("a-long-test-password");
    const auth = { ...password, sessionSecret: newSessionSecret() };
    expect(password.passwordHash).not.toContain("a-long-test-password");
    await expect(verifyPassword("a-long-test-password", auth)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", auth)).resolves.toBe(false);
  });

  it("signs expiring session tokens", async () => {
    const password = await hashPassword("a-long-test-password");
    const auth = { ...password, sessionSecret: newSessionSecret() };
    const token = createSessionToken(auth, 1_000);
    expect(verifySessionToken(token, auth, 2_000)).toBe(true);
    expect(verifySessionToken(`${token}x`, auth, 2_000)).toBe(false);
    expect(verifySessionToken(token, auth, 8 * 24 * 60 * 60 * 1000)).toBe(false);
  });
});
