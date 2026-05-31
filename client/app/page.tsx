import { redirect } from "next/navigation";
import { DEFAULT_MARKET_SYMBOL } from "@/config";

export default function Home() {
  redirect(`/trade/${DEFAULT_MARKET_SYMBOL}`);
}
