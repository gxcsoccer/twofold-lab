import type { Metadata } from "next";
import { Suspense } from "react";

import { AppShell } from "@/components/app-shell";
import { RoundSpine } from "@/components/round-spine";
import { loadSettingsData } from "@/lib/repositories";
import { readServerSupabaseConfig } from "@/lib/supabase/env";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Twofold Lab",
    template: "%s · Twofold Lab",
  },
  description: "面向模型与 Skill 的税后模拟交易实验。",
};

/** The chrome reads live projections (round spine, readiness), so the layout is
 *  request-scoped like every page under it already is. */
export const dynamic = "force-dynamic";

/**
 * Readiness is cross-page state, so the count lives in the masthead.
 *
 * "Nothing configured yet" is a known state — 0 of 7 — and it must match what
 * /settings shows. Only a failed read makes readiness genuinely unknown, and
 * then the chrome shows nothing rather than claiming a number.
 */
async function readReadiness(): Promise<{ ready: number; total: number } | null> {
  try {
    const settings = await loadSettingsData();
    if (settings.connection.readStatus === "ERROR") return null;
    return {
      ready: settings.checklist.filter((item) => item.status === "ready").length,
      total: settings.checklist.length,
    };
  } catch {
    // Next renders its built-in error page through this layout outside any
    // request scope, where a per-request read cannot run. The chrome drops the
    // counter rather than claiming a number it could not read.
    return null;
  }
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const serverDataConfigured = readServerSupabaseConfig() !== null;
  const readiness = await readReadiness();

  return (
    <html lang="zh-CN">
      <head>
        {/* Latin instrument faces are self-hosted-equivalent slices; the CJK
            serif is sliced by unicode-range, so only the glyphs actually used
            are fetched. `display=swap` keeps text painting unblocked, and the
            local fallbacks in --font-* keep the layout correct offline. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&family=Noto+Serif+SC:wght@600;700&display=swap"
        />
      </head>
      <body>
        <AppShell
          serverDataConfigured={serverDataConfigured}
          readiness={readiness}
          spine={
            serverDataConfigured ? (
              <Suspense fallback={<div className="spine spine-loading" />}>
                <RoundSpine />
              </Suspense>
            ) : null
          }
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
