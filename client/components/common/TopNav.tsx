"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletConnect } from "@/features/wallet/components/WalletConnect";
import { NotificationBell } from "@/features/navbar/components/NotificationBell";
import { SettingsMenu } from "@/features/navbar/components/SettingsMenu";
import { DEFAULT_MARKET_SYMBOL } from "@/config";

const TABS = [
  { label: "Trade", href: `/trade/${DEFAULT_MARKET_SYMBOL}`, match: "/trade" },
  { label: "Markets", href: "/markets", match: "/markets" },
  { label: "Portfolio", href: "/portfolio", match: "/portfolio" },
  { label: "Leaderboard", href: "/leaderboard", match: "/leaderboard" },
];

export function TopNav() {
  const pathname = usePathname() ?? "";

  return (
    <header className="flex items-center justify-between px-[14px] py-[6px] border-b border-[#2A2A31] shrink-0 bg-[#212128]">
      <div className="flex items-center gap-[12px]">
        <Link href="/" className="flex items-center gap-[8px] select-none">
          <Image src="/logo.png" alt="Kryon" width={36} height={11} priority className="object-contain" />
          <span
            className="text-[18px] font-bold text-[#f5f5f5]"
            style={{ fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}
          >
            KRYON
          </span>
        </Link>
        <nav className="flex gap-[6px]">
          {TABS.map((t) => {
            const active = pathname.startsWith(t.match);
            return (
              <Link
                key={t.label}
                href={t.href}
                className={`px-[12px] py-[6px] rounded-[6px] text-[13px] font-medium transition-colors ${
                  active ? "text-[#f5f5f5]" : "text-[#a3a3a3] hover:text-[#f5f5f5]"
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
