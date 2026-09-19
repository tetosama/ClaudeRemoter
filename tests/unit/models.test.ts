import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configuredModels } from "../../src/server/session/models.js";

describe("configuredModels", () => {
  it("returns only configured model values and deduplicates aliases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "remoter-models-"));
    await writeFile(join(dir, "settings.json"), JSON.stringify({
      model: "gateway-model-a",
      env: {
        ANTHROPIC_AUTH_TOKEN: "must-not-leak",
        ANTHROPIC_BASE_URL: "https://gateway.invalid",
        ANTHROPIC_MODEL: "gateway-model-a",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "gateway-model-b",
      },
    }));
    await expect(configuredModels(dir)).resolves.toEqual(["gateway-model-a", "gateway-model-b"]);
  });
});
