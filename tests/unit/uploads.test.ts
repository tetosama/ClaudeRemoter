import { describe, expect, it } from "vitest";
import { sanitizeFilename } from "../../src/server/data/uploads.js";

describe("upload filenames", () => {
  it("removes paths, control characters and dot prefixes", () => {
    expect(sanitizeFilename("../../secret.txt")).toBe("secret.txt");
    expect(sanitizeFilename("\u0000bad/name.png")).toBe("name.png");
    expect(sanitizeFilename("..." )).toBe("upload");
  });
});
