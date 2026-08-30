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

/** Two folds and a fence: the seal this console keeps. */
function Mark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <rect
        x="0.75"
        y="0.75"
        width="16.5"
        height="16.5"
        rx="1.5"
        fill="none"
        stroke="#d8a93c"
        strokeWidth="1.5"
      />
      <path d="M0.75 12.5 L12.5 0.75 L12.5 12.5 Z" fill="#d8a93c" fillOpacity="0.9" />
      <path d="M12.5 12.5 L17.25 12.5" stroke="#62b9a4" strokeWidth="1.5" />
    </svg>
  );
}

export function AppShell({
  children,
  spine,
  serverDataConfigured,
  readiness,
}: {
  children: React.ReactNode;
  spine: React.ReactNode;
  serverDataConfigured: boolean;
  readiness: { ready: number; total: number } | null;
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
    <>
      <a className="skip-link" href="#main-content">
        跳转至主要内容
      </a>

      <header className="masthead">
        <Link className="wordmark" href="/">
          <Mark />
          <strong>TWOFOLD LAB</strong>
        </Link>
        <p className="masthead-sub">税后模拟交易研究 · 只读控制台</p>
        <div className="masthead-meta">
          <span className="environment-status" aria-live="polite">
            <span className={statusDotClass} />
            <span>{environmentLabel}</span>
          </span>
          {readiness ? (
            <Link
              className="readiness"
              href="/settings"
              title="正式输入就绪进度"
            >
              <strong>{readiness.ready} / {readiness.total}</strong>
              <span>正式输入就绪</span>
            </Link>
          ) : null}
        </div>
      </header>

      <div className="app-frame">
        <aside className="sidebar">
          <p className="rail-label">Console</p>
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
            <p>不下实盘订单，不保存券商凭证，不在浏览器持有任何密钥。</p>
          </div>
        </aside>

        <div className="app-body">
          {spine}
          <main id="main-content" className="main-content">
            {children}
          </main>
        </div>
      </div>
    </>
  );
}
