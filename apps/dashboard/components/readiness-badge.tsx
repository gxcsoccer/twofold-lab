import Link from "next/link";

import { loadSettingsData } from "@/lib/repositories";

/**
 * Readiness is cross-page state, so the count lives in the masthead.
 *
 * "Nothing configured yet" is a known state — 0 of 7 — and it matches what
 * /settings shows. Only a failed read makes readiness genuinely unknown, and
 * then the chrome shows nothing rather than claiming a number.
 */
export async function ReadinessBadge() {
  let ready: number;
  let total: number;
  try {
    const settings = await loadSettingsData();
    if (settings.connection.readStatus === "ERROR") return null;
    ready = settings.checklist.filter((item) => item.status === "ready").length;
    total = settings.checklist.length;
  } catch {
    // Next renders its built-in error pages through this layout outside any
    // request scope, where a per-request read cannot run.
    return null;
  }

  return (
    <Link className="readiness" href="/settings" title="正式输入就绪进度">
      <strong>{ready} / {total}</strong>
      <span>正式输入就绪</span>
    </Link>
  );
}
