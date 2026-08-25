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

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <AppShell serverDataConfigured={readServerSupabaseConfig() !== null}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
