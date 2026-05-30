"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletConnect } from "@/features/wallet/components/WalletConnect";
import { NotificationBell } from "@/features/navbar/components/NotificationBell";
import { SettingsMenu } from "@/features/navbar/components/SettingsMenu";

const TABS = [
  { label: "Trade", href: "/trade/XLM-PERP", match: "/trade" },
  { label: "Portfolio", href: "/portfolio", match: "/portfolio" },
  { label: "Leaderboard", href: "/leaderboard", match: "/leaderboard" },
];

export function TopNav() {
  const pathname = usePathname() ?? "";

  return (
    <header className="flex items-center justify-between px-[16px] py-[8px] border-b border-[#1f232a] shrink-0 bg-[#0f1217]">
      <div className="flex items-center gap-[12px]">
        <Link href="/trade/XLM-PERP" className="flex items-center gap-[8px] select-none">
          <Image src="/logo.png" alt="Kryon" width={44} height={13} priority className="object-contain" />
          <span className="font-bold tracking-[.18em] text-[19px] text-[#e6e6e6]" style={{ fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}>KRYON</span>
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
