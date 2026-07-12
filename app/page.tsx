import type { Metadata } from "next";
import { GameApp } from "@/src/client/GameApp";

export const metadata: Metadata = {
  title: "Hex Dominion — Territory bends to the bold",
  description:
    "A real-time procedural hex strategy game of expansion, local armies, animated battles, and deterministic AI.",
};

export default function Home() {
  return <GameApp />;
}
