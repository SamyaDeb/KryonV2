import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "Kryon | Perpetuals DEX",
  description: "Decentralised perpetual futures on Stellar/Soroban — XLM-PERP",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable} dark h-full`}>
      <body className="h-full bg-[#0b0e14] text-slate-200 antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
