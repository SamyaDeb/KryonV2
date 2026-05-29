"use client";

import { useState } from "react";
import { TopNav } from "@/components/common/TopNav";

const CaretIcon = () => (
  <svg width={10} height={10} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M3 4.5 L6 7.5 L9 4.5" />
  </svg>
);

const COLS = ["Rank", "Trader", "Account Value", "PNL (30D)", "ROI (30D)", "Volume (30D)"];

export default function LeaderboardPage() {
  const [search, setSearch] = useState("");

  return (
    <div className="min-h-screen bg-black text-[#e6e6e6]" style={{ fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}>
      <TopNav />
      <main className="px-6 py-6 max-w-[1200px] mx-auto">
        <h1 className="text-[34px] font-bold tracking-tight mb-5">Leaderboard</h1>

        <div className="rounded-xl border border-[#1f232a] bg-[#0f1217] overflow-hidden">
          {/* Controls */}
          <div className="flex items-center justify-between gap-4 p-4 border-b border-[#1f232a]">
            <div className="relative flex-1 max-w-[520px]">
              <svg
                width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5a5f66]"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by wallet address…"
                className="w-full rounded-[8px] border border-[#1f232a] bg-[#14171c] pl-9 pr-3 py-[10px] text-[13px] text-[#e6e6e6] placeholder:text-[#5a5f66] outline-none focus:border-[#2a2f37]"
              />
            </div>
            <button className="flex items-center gap-2 rounded-[8px] border border-[#1f232a] bg-[#14171c] px-3 py-[10px] text-[12.5px] text-[#e6e6e6] hover:border-[#2a2f37] transition-colors">
              30D <CaretIcon />
            </button>
          </div>

          {/* Header row */}
          <div className="grid grid-cols-[60px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1fr)] px-4 py-3 text-[12px] text-[#8a8f97] border-b border-[#1f232a]">
            {COLS.map((c, i) => (
              <span key={c} className={`${i >= 2 ? "" : ""} ${i === 3 ? "flex items-center gap-1" : ""}`}>
                {c}
                {i === 3 && <CaretIcon />}
              </span>
            ))}
          </div>

          {/* Body — no leaderboard data source on this network */}
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-[13px] text-[#5a6585]">
            <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 19V5M10 19V9M16 19v-6M22 19V3" />
            </svg>
            <span className="text-[#8a8f97]">Leaderboard rankings aren&rsquo;t available on this network yet.</span>
            <span className="text-[12px] text-[#5a5f66]">Once the indexer publishes trader stats, they&rsquo;ll appear here.</span>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-end gap-4 px-4 py-3 border-t border-[#1f232a] text-[12.5px] text-[#8a8f97]">
            <span className="flex items-center gap-2">
              Rows per page:
              <span className="flex items-center gap-1 text-[#e6e6e6]">10 <CaretIcon /></span>
            </span>
            <span className="tabular">0–0 of 0</span>
            <div className="flex items-center gap-1">
              <button disabled className="w-7 h-7 grid place-items-center rounded-[6px] text-[#3a3f47]">
                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
              </button>
              <button disabled className="w-7 h-7 grid place-items-center rounded-[6px] text-[#3a3f47]">
                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6" /></svg>
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
