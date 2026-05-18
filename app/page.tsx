"use client";

import { useEffect, useRef, useState } from "react";
import UniverseBuilder from "@/components/UniverseBuilder";
import ChartPanel from "@/components/ChartPanel";
import type { SeriesData } from "@/lib/types";

const STORAGE_KEY = "correlations-app:series:v1";

export default function Home() {
  const [series, setSeries] = useState<SeriesData[]>([]);
  const hydrated = useRef(false);

  // hydrate from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setSeries(parsed as SeriesData[]);
      }
    } catch {
      // ignore corrupted storage
    }
    hydrated.current = true;
  }, []);

  // persist on every change (after first hydration)
  useEffect(() => {
    if (!hydrated.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(series));
    } catch {
      // quota or private mode — silently ignore
    }
  }, [series]);

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
