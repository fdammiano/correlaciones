"use client";

import { useState } from "react";
import UniverseBuilder from "@/components/UniverseBuilder";
import ChartPanel from "@/components/ChartPanel";
import type { SeriesData } from "@/lib/types";

export default function Home() {
  const [series, setSeries] = useState<SeriesData[]>([]);

  function add(newOnes: SeriesData[]) {
    setSeries((prev) => {
      const map = new Map(prev.map((s) => [s.id, s]));
      newOnes.forEach((s) => map.set(s.id, s));
      return Array.from(map.values());
    });
  }
  function remove(id: string) {
    setSeries((prev) => prev.filter((s) => s.id !== id));
  }

  return (
    <main className="flex">
      <UniverseBuilder
        series={series}
        onAdd={add}
        onRemove={remove}
        onClear={() => setSeries([])}
      />
      <ChartPanel series={series} />
    </main>
  );
}
