import type { Metadata } from "next";

import { AppShell } from "@/components/app-shell";
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

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <head>
        {/* The CJK serif is sliced by unicode-range, so only the glyphs actually
            used are fetched. `display=swap` keeps text painting unblocked, and
            the local fallbacks in --font-* keep the layout correct offline. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&family=Noto+Serif+SC:wght@600;700&display=swap"
        />
      </head>
      <body>
        <AppShell serverDataConfigured={readServerSupabaseConfig() !== null}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
