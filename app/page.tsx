"use client";

import dynamic from "next/dynamic";
import Overlay from "@/components/Overlay";

const Scene = dynamic(() => import("@/components/Scene"), { ssr: false });

export default function Home() {
  return (
    <main className="relative w-screen h-screen bg-black">
      <Scene />
      <Overlay />
    </main>
  );
}
