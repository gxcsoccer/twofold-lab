import { describe, expect, it } from "vitest";

import { arenaArtifactRegistrationIdentity } from
  "../src/arena-repository.js";

describe("Arena artifact registration identity", () => {
  it("uses a Season scope only when reusable Bundle bytes are not registered", () => {
    expect(arenaArtifactRegistrationIdentity({
      runScoped: false,
      artifactKind: "dsh_agent_bundle_manifest",
      sha256: "a".repeat(64),
      runId: "run-1",
      seasonId: "season-2",
      workerId: "worker-1",
    })).toEqual({
      idempotencyKey:
        `arena:season:season-2:dsh_agent_bundle_manifest:${"a".repeat(64)}`,
      runId: null,
      seasonId: "season-2",
      createdBy: "twofold-bundle-registry",
    });
  });

  it("keeps decision packets scoped to their Run and Season", () => {
    expect(arenaArtifactRegistrationIdentity({
      runScoped: true,
      artifactKind: "decision_packet",
      sha256: "b".repeat(64),
      runId: "run-1",
      seasonId: "season-2",
      workerId: "worker-1",
    })).toEqual({
      idempotencyKey: `arena:decision_packet:${"b".repeat(64)}`,
      runId: "run-1",
      seasonId: "season-2",
      createdBy: "worker-1",
    });
  });
});
