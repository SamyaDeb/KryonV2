"use client";

import { memo, useEffect, useId, useRef, useState } from "react";

// Renders TradingView's Advanced Chart (the real widget engine, loaded from
// tv.js). Data, indicators, drawing tools and chart types are all handled by
// TradingView itself, so this works regardless of the viewer's region.

declare global {
  interface Window {
    TradingView?: {
      widget: new (config: Record<string, unknown>) => unknown;
    };
  }
}

const SCRIPT_ID = "tradingview-embed-script";
const SCRIPT_SRC = "https://s3.tradingview.com/tv.js";

function loadScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return resolve();
    if (window.TradingView) return resolve();
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("tv.js failed to load")), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.id = SCRIPT_ID;
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("tv.js failed to load"));
    document.head.appendChild(s);
  });
}

// Kryon dark palette
const BG = "#0f1217";
const GRID = "#161a20";
const SCALE_LINE = "#1f232a";
const SCALE_TEXT = "#8a8f97";
const UP = "#1fae5b";
const DOWN = "#e34c4c";

export const TradingViewWidget = memo(function TradingViewWidget({
  symbol = "COINBASE:XLMUSD",
  interval = "60",
  chartStyle = "1",
}: {
  symbol?: string;
  interval?: string;
  chartStyle?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mountId = `tv_${useId().replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    setLoading(true);
    setError(null);
    host.innerHTML = "";
    const inner = document.createElement("div");
    inner.id = mountId;
    inner.style.width = "100%";
    // Push TradingView's bottom branding bar just out of view
    inner.style.height = "calc(100% + 32px)";
    host.appendChild(inner);

    const loaderFallback = setTimeout(() => {
      if (!cancelled) setLoading(false);
    }, 6000);

    loadScript()
      .then(() => {
        if (cancelled || !window.TradingView) return;
        const widget = new window.TradingView.widget({
          autosize: true,
          symbol,
          interval,
          timezone: "Etc/UTC",
          theme: "dark",
          style: chartStyle,
          locale: "en",
          backgroundColor: BG,
          gridColor: GRID,
          toolbar_bg: BG,
          enable_publishing: false,
          allow_symbol_change: false,
          hide_top_toolbar: false,
          hide_side_toolbar: false,
          hide_legend: false,
          save_image: false,
          withdateranges: false,
          details: false,
          calendar: false,
          container_id: mountId,
          loading_screen: { backgroundColor: BG, foregroundColor: SCALE_TEXT },
          disabled_features: [
            "timeframes_toolbar",
            "header_symbol_search",
            "header_compare",
            "use_localstorage_for_settings",
          ],
          overrides: {
            "paneProperties.background": BG,
            "paneProperties.backgroundType": "solid",
            "paneProperties.vertGridProperties.color": GRID,
            "paneProperties.horzGridProperties.color": GRID,
            "scalesProperties.backgroundColor": BG,
            "scalesProperties.lineColor": SCALE_LINE,
            "scalesProperties.textColor": SCALE_TEXT,
            "mainSeriesProperties.candleStyle.upColor": UP,
            "mainSeriesProperties.candleStyle.downColor": DOWN,
            "mainSeriesProperties.candleStyle.borderUpColor": UP,
            "mainSeriesProperties.candleStyle.borderDownColor": DOWN,
            "mainSeriesProperties.candleStyle.wickUpColor": UP,
            "mainSeriesProperties.candleStyle.wickDownColor": DOWN,
          },
        });
        void widget;
        // tv.js advanced widget has no reliable onChartReady; drop the loader
        // shortly after construction (the iframe paints its own loader too).
        setTimeout(() => {
          if (!cancelled) setLoading(false);
        }, 1200);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Chart failed to load");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      clearTimeout(loaderFallback);
      if (host) host.innerHTML = "";
    };
  }, [symbol, interval, chartStyle, mountId, retryNonce]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={hostRef} className="h-full w-full" />
      {(loading || error) && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0f1217]">
          {error ? (
            <div className="flex flex-col items-center gap-3">
              <span className="text-xs font-mono text-[#8a8f97]">Chart unavailable</span>
              <span className="max-w-[260px] text-center text-[11px] text-[#5a5f67]">{error}</span>
              <button
                onClick={() => setRetryNonce((v) => v + 1)}
                className="rounded-[6px] bg-[#14171c] border border-[#1f232a] px-3 py-1.5 text-[11px] font-medium text-[#e6e6e6] hover:border-[#2a2f37] transition-colors"
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 pointer-events-none">
              <div className="w-5 h-5 border-2 border-[#1f232a] border-t-[#8a8f97] rounded-full animate-spin" />
              <span className="text-[#5a5f67] text-xs font-mono">Loading chart…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
