"use client";

import React from "react";

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surface to console for diagnostics; in prod this would also report to telemetry.
    console.error("[Kryon] UI error boundary caught:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-full flex-col items-center justify-center gap-4 bg-black text-[#e6e6e6]">
          <div className="text-[15px] font-semibold">Something went wrong</div>
          <div className="max-w-[420px] px-6 text-center text-[12px] leading-relaxed text-[#8a8f97]">
            {this.state.error?.message ?? "An unexpected error occurred while rendering the app."}
          </div>
          <button
            onClick={() => window.location.reload()}
            className="rounded-[8px] bg-[#f7931a] px-4 py-2 text-[13px] font-semibold text-[#1a1205] hover:brightness-110 transition"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
