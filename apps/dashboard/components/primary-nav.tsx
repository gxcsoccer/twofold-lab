"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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

/** Needs the current path, so it is the only client part of the rail. */
export function PrimaryNav() {
  const pathname = usePathname();

  return (
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
  );
}
