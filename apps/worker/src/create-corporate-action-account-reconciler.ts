import { createClient } from "@supabase/supabase-js";

import { CorporateActionAccountReconciler } from
  "./corporate-action-account-reconciler.js";
import {
  reconcileCorporateActionWork,
  type CorporateActionReconciliationClient,
} from "./corporate-action-account-runner.js";
import { loadEcbFxConfig } from "./ecb-fx.js";
import { SupabaseCorporateActionDividendPolicyProvider } from
  "./supabase-corporate-action-dividend-policy.js";
import {
  loadCorporateActionAccountWork,
  type CorporateActionWorkRpcClient,
} from "./corporate-action-work-repository.js";
import type { WorkerConfig } from "./config.js";

export function createCorporateActionAccountReconciler(
  config: WorkerConfig,
): CorporateActionAccountReconciler {
  const client = createClient(
    config.supabaseUrl!,
    config.supabaseSecretKey!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  ) as unknown as CorporateActionWorkRpcClient & CorporateActionReconciliationClient;
  const dividendPolicy = new SupabaseCorporateActionDividendPolicyProvider({
    url: config.supabaseUrl!,
    secretKey: config.supabaseSecretKey!,
    workerId: config.workerId,
    ecb: loadEcbFxConfig(),
  });
  return new CorporateActionAccountReconciler({
    recordedBy: config.workerId,
    source: {
      load: (asOf) => loadCorporateActionAccountWork(client, asOf),
    },
    reconcile: (work, recordedBy, signal) => reconcileCorporateActionWork(
      client,
      work,
      recordedBy,
      { dividendPolicy, signal },
    ),
  });
}
