import { describe, expect, it } from "vitest";
import config from "./next.config";

describe("serverless profile tracing", () => {
  it("traces profile configuration without following local node_modules symlinks", () => {
    const paths = config.outputFileTracingIncludes!["/api/arena/tick"]!;
    expect(paths).not.toContain("../../profiles/twofold/**/*");
    expect(paths).toContain("../../profiles/twofold/package.json");
    expect(paths).toContain("../../profiles/twofold/*.yml");
    expect(paths).toContain("../../profiles/twofold/agent-presets/**/*.yml");
  });
});
