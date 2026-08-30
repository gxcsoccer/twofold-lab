/**
 * Cordis loads profile rows by package name, which a server bundler cannot
 * discover from YAML. Literal import specifiers make the exact active runtime
 * surface traceable while keeping profile composition authoritative.
 */
const RUNTIME_PACKAGE_LOADERS = Object.freeze({
  "@deepseek-ai/cordis-plugin-timer": () => import("@deepseek-ai/cordis-plugin-timer"),
  "@deepseek-ai/dsh-agent": () => import("@deepseek-ai/dsh-agent"),
  "@deepseek-ai/dsh-agent-default-model": () => import("@deepseek-ai/dsh-agent-default-model"),
  "@deepseek-ai/dsh-agent-loop": () => import("@deepseek-ai/dsh-agent-loop"),
  "@deepseek-ai/dsh-agent-presets": () => import("@deepseek-ai/dsh-agent-presets"),
  "@deepseek-ai/dsh-api-gateway": () => import("@deepseek-ai/dsh-api-gateway"),
  "@deepseek-ai/dsh-attachment-local": () => import("@deepseek-ai/dsh-attachment-local"),
  "@deepseek-ai/dsh-bash-sandbox": () => import("@deepseek-ai/dsh-bash-sandbox"),
  "@deepseek-ai/dsh-base": () => import("@deepseek-ai/dsh-base"),
  "@deepseek-ai/dsh-command-compact": () => import("@deepseek-ai/dsh-command-compact"),
  "@deepseek-ai/dsh-command-feedback": () => import("@deepseek-ai/dsh-command-feedback"),
  "@deepseek-ai/dsh-command-goal": () => import("@deepseek-ai/dsh-command-goal"),
  "@deepseek-ai/dsh-commands": () => import("@deepseek-ai/dsh-commands"),
  "@deepseek-ai/dsh-compaction-basic": () => import("@deepseek-ai/dsh-compaction-basic"),
  "@deepseek-ai/dsh-compaction-tool-result-pruner": () => import("@deepseek-ai/dsh-compaction-tool-result-pruner"),
  "@deepseek-ai/dsh-credentials-local": () => import("@deepseek-ai/dsh-credentials-local"),
  "@deepseek-ai/dsh-fs-observation-policy": () => import("@deepseek-ai/dsh-fs-observation-policy"),
  "@deepseek-ai/dsh-fs-sandbox": () => import("@deepseek-ai/dsh-fs-sandbox"),
  "@deepseek-ai/dsh-goal": () => import("@deepseek-ai/dsh-goal"),
  "@deepseek-ai/dsh-goal-round-driver": () => import("@deepseek-ai/dsh-goal-round-driver"),
  "@deepseek-ai/dsh-jobs-local": () => import("@deepseek-ai/dsh-jobs-local"),
  "@deepseek-ai/dsh-llm": () => import("@deepseek-ai/dsh-llm"),
  "@deepseek-ai/dsh-llm-deepseek": () => import("@deepseek-ai/dsh-llm-deepseek"),
  "@deepseek-ai/dsh-llm-retry": () => import("@deepseek-ai/dsh-llm-retry"),
  "@deepseek-ai/dsh-permission-presets": () => import("@deepseek-ai/dsh-permission-presets"),
  "@deepseek-ai/dsh-pwsh-sandbox": () => import("@deepseek-ai/dsh-pwsh-sandbox"),
  "@deepseek-ai/dsh-repeat-tool-reminder": () => import("@deepseek-ai/dsh-repeat-tool-reminder"),
  "@deepseek-ai/dsh-sandbox-local": () => import("@deepseek-ai/dsh-sandbox-local"),
  "@deepseek-ai/dsh-sandbox-policy": () => import("@deepseek-ai/dsh-sandbox-policy"),
  "@deepseek-ai/dsh-session": () => import("@deepseek-ai/dsh-session"),
  "@deepseek-ai/dsh-session-checkpoint-policy": () => import("@deepseek-ai/dsh-session-checkpoint-policy"),
  "@deepseek-ai/dsh-session-persistence-jsonl": () => import("@deepseek-ai/dsh-session-persistence-jsonl"),
  "@deepseek-ai/dsh-session-projection": () => import("@deepseek-ai/dsh-session-projection"),
  "@deepseek-ai/dsh-session-query-sqlite": () => import("@deepseek-ai/dsh-session-query-sqlite"),
  "@deepseek-ai/dsh-session-title": () => import("@deepseek-ai/dsh-session-title"),
  "@deepseek-ai/dsh-shell-env": () => import("@deepseek-ai/dsh-shell-env"),
  "@deepseek-ai/dsh-skill": () => import("@deepseek-ai/dsh-skill"),
  "@deepseek-ai/dsh-spill-local": () => import("@deepseek-ai/dsh-spill-local"),
  "@deepseek-ai/dsh-spill-policy": () => import("@deepseek-ai/dsh-spill-policy"),
  "@deepseek-ai/dsh-subagent": () => import("@deepseek-ai/dsh-subagent"),
  "@deepseek-ai/dsh-subagent-fork-in-process": () => import("@deepseek-ai/dsh-subagent-fork-in-process"),
  "@deepseek-ai/dsh-subagent-spawn-in-process": () => import("@deepseek-ai/dsh-subagent-spawn-in-process"),
  "@deepseek-ai/dsh-subprocess-local": () => import("@deepseek-ai/dsh-subprocess-local"),
  "@deepseek-ai/dsh-system-prompt": () => import("@deepseek-ai/dsh-system-prompt"),
  "@deepseek-ai/dsh-token-meter": () => import("@deepseek-ai/dsh-token-meter"),
  "@deepseek-ai/dsh-tool-call-timeout-policy": () => import("@deepseek-ai/dsh-tool-call-timeout-policy"),
  "@deepseek-ai/dsh-tool-subagent": () => import("@deepseek-ai/dsh-tool-subagent"),
  "@deepseek-ai/dsh-tools": () => import("@deepseek-ai/dsh-tools"),
  "@deepseek-ai/dsh-typert-loader": () => import("@deepseek-ai/dsh-typert-loader"),
  "@deepseek-ai/dsh-typert-registry": () => import("@deepseek-ai/dsh-typert-registry"),
  "@deepseek-ai/dsh-user-approval": () => import("@deepseek-ai/dsh-user-approval"),
  "@deepseek-ai/dsh-user-questions": () => import("@deepseek-ai/dsh-user-questions"),
  "@twofold-lab/dsh-twofold": () => import("@twofold-lab/dsh-twofold"),
  "@twofold-lab/dsh-twofold/agent": () => import("@twofold-lab/dsh-twofold/agent"),
  "@twofold-lab/dsh-twofold/orchestrator": () => import("@twofold-lab/dsh-twofold/orchestrator"),
});

export const ARENA_RUNTIME_PACKAGE_NAMES = Object.freeze(
  Object.keys(RUNTIME_PACKAGE_LOADERS),
);

export async function importArenaRuntimePackage(specifier: string): Promise<unknown> {
  const load = RUNTIME_PACKAGE_LOADERS[
    specifier as keyof typeof RUNTIME_PACKAGE_LOADERS
  ];
  if (load === undefined) {
    throw new TypeError(
      `Arena runtime package is not declared in the serverless manifest: ${specifier}`,
    );
  }
  return load();
}

let loaded: Promise<void> | undefined;

export function loadArenaRuntimePackages(): Promise<void> {
  loaded ??= Promise.all(
    Object.values(RUNTIME_PACKAGE_LOADERS).map((load) => load()),
  ).then(() => undefined);
  return loaded;
}
