import type { Metadata } from "next";
import { Poppins, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/common/Providers";
import "./globals.css";

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-poppins",
  display: "swap",
});
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "Kryon | Perpetuals DEX",
  description: "Decentralised perpetual futures on Stellar/Soroban — XLM-PERP",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${poppins.variable} ${geistMono.variable} dark h-full`}>
      <body className="h-full bg-[#000000] text-slate-200 antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
