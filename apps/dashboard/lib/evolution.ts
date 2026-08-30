import "server-only";

import {
  buildEvolutionOverview,
  unavailableEvolutionOverview,
  type EvolutionOverview,
} from "@/lib/data/evolution-overview";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function loadEvolutionOverview(): Promise<EvolutionOverview> {
  const client = createServerSupabaseClient();
  if (client === null) return unavailableEvolutionOverview(null);
  const [cycles, findings, experiments, trials, decisionEvaluations] = await Promise.all([
    client.from("evolution_cycle")
      .select("cycle_id,window_started_at,window_ended_at,status,report_sha256,analysis_report")
      .order("window_ended_at", { ascending: false }).limit(12),
    client.from("evolution_finding")
      .select("finding_sha256,finding,recorded_at")
      .order("recorded_at", { ascending: false }).limit(50),
    client.from("evolution_experiment")
      .select("experiment_id,experiment_code,mode,status,ranking_scope,human_approved_at,result,updated_at")
      .order("updated_at", { ascending: false }).limit(50),
    client.from("evolution_trial")
      .select("trial_id,experiment_id,trial_code,mode,ranking_scope,season_id,round_id")
      .order("scheduled_at", { ascending: false }).limit(50),
    client.from("decision_evolution_evaluation")
      .select("evaluation_sha256,experiment_id,evidence_snapshot_id,comparison_sha256,evaluation,recorded_at")
      .order("recorded_at", { ascending: false }).limit(50),
  ]);
  const failure = [
    cycles.error,
    findings.error,
    experiments.error,
    trials.error,
    decisionEvaluations.error,
  ]
    .find((value) => value !== null);
  if (failure !== undefined) {
    console.error(`[dashboard] evolution overview failed (${failure.code})`);
    return unavailableEvolutionOverview(failure.code);
  }
  try {
    return buildEvolutionOverview({
      cycles: cycles.data ?? [],
      findings: findings.data ?? [],
      experiments: experiments.data ?? [],
      trials: trials.data ?? [],
      decisionEvaluations: decisionEvaluations.data ?? [],
    });
  } catch {
    return unavailableEvolutionOverview("EVOLUTION_CONTRACT_INVALID");
  }
}
