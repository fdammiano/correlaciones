"use client";

import { useEffect, useMemo, useState } from "react";
import UniverseBuilder from "@/components/UniverseBuilder";
import ChartPanel from "@/components/ChartPanel";
import type { SeriesData } from "@/lib/types";

const STORAGE_KEY = "correlations-app:series:v1";

export default function Home() {
  const [series, setSeries] = useState<SeriesData[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const normalized = (parsed as SeriesData[]).map((s) => ({
            ...s,
            active: s.active !== false,
          }));
          setSeries(normalized);
        }
      }
    } catch {
      // ignore corrupted storage
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(series));
    } catch (err) {
      // QuotaExceeded — fall back to keeping only custom (hand-pasted) series,
      // since Ken French and Yahoo data can be re-fetched.
      try {
        const customOnly = series.filter((s) => s.source === "custom");
        localStorage.setItem(STORAGE_KEY, JSON.stringify(customOnly));
        console.warn("localStorage lleno: solo se guardan series pegadas a mano.");
      } catch {
        console.warn("localStorage lleno y no se pudo guardar.");
      }
    }
  }, [series, hydrated]);

  function add(newOnes: SeriesData[]) {
    setSeries((prev) => {
      const map = new Map(prev.map((s) => [s.id, s]));
      newOnes.forEach((s) => map.set(s.id, { ...s, active: true }));
      return Array.from(map.values());
    });
  }
  function remove(id: string) {
    setSeries((prev) => prev.filter((s) => s.id !== id));
  }
  function toggleActive(id: string) {
    setSeries((prev) =>
      prev.map((s) => (s.id === id ? { ...s, active: s.active === false } : s)),
    );
  }
  function setAllActive(active: boolean) {
    setSeries((prev) => prev.map((s) => ({ ...s, active })));
  }

  const activeSeries = useMemo(
    () => series.filter((s) => s.active !== false),
    [series],
  );

  return (
    <main className="flex">
      <UniverseBuilder
        series={series}
        onAdd={add}
        onRemove={remove}
        onClear={() => setSeries([])}
        onToggleActive={toggleActive}
        onSetAllActive={setAllActive}
      />
      <ChartPanel series={activeSeries} />
    </main>
  );
}
