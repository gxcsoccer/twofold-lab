import Link from "next/link";
import { Suspense } from "react";

import { EnvironmentStatus } from "@/components/environment-status";
import { PrimaryNav } from "@/components/primary-nav";
import { ReadinessBadge } from "@/components/readiness-badge";
import { RoundSpine } from "@/components/round-spine";

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

/**
 * The console chrome.
 *
 * This is a Server Component so that the two parts which read projections — the
 * round spine and the readiness count — can be composed here directly instead
 * of being handed to a Client Component as element props. Only the two pieces
 * that genuinely need browser state are client: the realtime indicator and the
 * nav, which needs the current path.
 */
export function AppShell({
  children,
  serverDataConfigured,
}: {
  children: React.ReactNode;
  serverDataConfigured: boolean;
}) {
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
          <EnvironmentStatus serverDataConfigured={serverDataConfigured} />
          <Suspense fallback={null}>
            <ReadinessBadge />
          </Suspense>
        </div>
      </header>

      <div className="app-frame">
        <aside className="sidebar">
          <p className="rail-label">Console</p>
          <PrimaryNav />
          <div className="sidebar-footnote">
            <span>研究环境</span>
            <p>不下实盘订单，不保存券商凭证，不在浏览器持有任何密钥。</p>
          </div>
        </aside>

        <div className="app-body">
          {serverDataConfigured ? (
            <Suspense fallback={<div className="spine spine-loading" />}>
              <RoundSpine />
            </Suspense>
          ) : null}
          <main id="main-content" className="main-content">
            {children}
          </main>
        </div>
      </div>
    </>
  );
}
