import type { Metadata } from "next";
import { GameApp } from "@/src/client/GameApp";

export const metadata: Metadata = {
  title: "Hex Dominion — Command the counter",
  description:
    "A real-time hex strategy game of compact chokepoint maps, typed armies, animated battles, and deterministic AI.",
};

export default function Home() {
  return <GameApp />;
}
