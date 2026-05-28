"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useRef } from "react";

export function Providers({ children }: { children: React.ReactNode }) {
  const clientRef = useRef<QueryClient>(null);
  if (!clientRef.current) {
    clientRef.current = new QueryClient({
      defaultOptions: { queries: { staleTime: 5_000, refetchInterval: 10_000, retry: 1 } },
    });
  }

  return (
    <QueryClientProvider client={clientRef.current}>
      <TooltipProvider delay={300}>
        {children}
        <Toaster position="bottom-right" theme="dark" />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
