"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useRealtimeRefresh } from "@/lib/supabase/realtime";

const navigation = [
  { href: "/", label: "赛季概览", exact: true },
  { href: "/data", label: "真实数据", exact: false },
  { href: "/audit", label: "审计", exact: false },
  { href: "/evolution", label: "自进化", exact: false },
  { href: "/settings", label: "设置", exact: false },
];

function isActive(pathname: string, href: string, exact: boolean): boolean {
  return exact ? pathname === href : pathname.startsWith(href.split("/").slice(0, 2).join("/"));
}

export function AppShell({
  children,
  serverDataConfigured,
}: {
  children: React.ReactNode;
  serverDataConfigured: boolean;
}) {
  const pathname = usePathname();
  const realtimeStatus = useRealtimeRefresh(true);
  const environmentLabel = realtimeStatus === "live"
      ? "实时 · Supabase"
      : realtimeStatus === "connecting"
        ? "正在连接 · Supabase"
        : realtimeStatus === "unauthenticated"
          ? serverDataConfigured
            ? "真实投影 · 手动刷新"
            : "需要登录 Supabase"
        : realtimeStatus === "degraded"
          ? "实时连接异常"
          : serverDataConfigured
            ? "真实数据 · 服务端 Supabase"
            : "需要完成真实数据设置";
  const statusDotClass = realtimeStatus === "live"
      ? "status-dot status-dot-live"
      : realtimeStatus === "degraded"
        ? "status-dot status-dot-degraded"
        : "status-dot";

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">
        跳转至主要内容
      </a>
      <aside className="sidebar">
        <div className="brand-block">
          <Link href="/" className="brand-name">
            Twofold Lab
          </Link>
          <p>税后模拟交易研究</p>
        </div>

        <nav className="primary-nav" aria-label="主导航">
          {navigation.map((item) => {
            const active = isActive(pathname, item.href, item.exact);
            return (
              <Link
                key={item.href}
                className={active ? "nav-link nav-link-active" : "nav-link"}
                href={item.href}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-footnote">
          <span>研究环境</span>
          <p>不下实盘订单，不保存券商凭证。</p>
        </div>
      </aside>

      <div className="app-body">
        <header className="topbar">
          <div className="environment-status" aria-live="polite">
            <span className={statusDotClass} />
            <span>{environmentLabel}</span>
          </div>
          <Link className="text-link" href="/data">
            查看真实数据状态
          </Link>
        </header>
        <main id="main-content" className="main-content">
          {children}
        </main>
      </div>
    </div>
  );
}
