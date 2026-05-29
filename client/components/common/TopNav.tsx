"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletConnect } from "@/features/wallet/components/WalletConnect";
import { NotificationBell } from "@/features/navbar/components/NotificationBell";
import { SettingsMenu } from "@/features/navbar/components/SettingsMenu";

export function KryonMark({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" width={size} height={size}>
      <path d="M16 2 L29 9 L29 23 L16 30 L3 23 L3 9 Z" stroke="#f7931a" strokeWidth="1.8" />
      <path d="M16 9 L23 13 L23 19 L16 23 L9 19 L9 13 Z" fill="#f7931a" />
      <path d="M16 2 L16 30 M3 9 L29 23 M29 9 L3 23" stroke="#f7931a" strokeWidth="0.6" opacity={0.35} />
    </svg>
  );
}

const TABS = [
  { label: "Trade", href: "/trade/XLM-PERP", match: "/trade" },
  { label: "Portfolio", href: "/portfolio", match: "/portfolio" },
  { label: "Leaderboard", href: "/leaderboard", match: "/leaderboard" },
];

export function TopNav() {
  const pathname = usePathname() ?? "";

  return (
    <header className="flex items-center justify-between px-[16px] py-[8px] border-b border-[#1f232a] shrink-0 bg-[#0f1217]">
      <div className="flex items-center gap-[34px]">
        <Link
          href="/trade/XLM-PERP"
          className="flex items-center gap-[10px] font-bold tracking-[.18em] text-[14px] text-[#e6e6e6] select-none"
        >
          <KryonMark />
          Kryon
        </Link>
        <nav className="flex gap-[6px]">
          {TABS.map((t) => {
            const active = pathname.startsWith(t.match);
            return (
              <Link
                key={t.label}
                href={t.href}
                className={`px-[14px] py-[8px] rounded-[6px] text-[13.5px] font-medium transition-colors ${
                  active ? "text-white" : "text-[#8a8f97] hover:text-[#e6e6e6]"
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      </div>
      <div className="flex items-center gap-[12px]">
        <WalletConnect />
        <NotificationBell />
        <SettingsMenu />
      </div>
    </header>
  );
}
