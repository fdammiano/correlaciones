"use client";

import { useEffect, useMemo, useState } from "react";
import UniverseBuilder from "@/components/UniverseBuilder";
import ChartPanel from "@/components/ChartPanel";
import type { SeriesData } from "@/lib/types";

const STORAGE_KEY = "correlations-app:series:v1";

function normalize(parsed: SeriesData[]): SeriesData[] {
  return parsed.map((s) => ({ ...s, active: s.active !== false }));
}

export default function Home() {
  const [series, setSeries] = useState<SeriesData[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [serverConfigured, setServerConfigured] = useState(false);

  // hydrate: prefer server (shared), fall back to localStorage (per-browser)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/universe", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (cancelled) return;
          if (data?.configured) {
            setServerConfigured(true);
            if (Array.isArray(data.universe) && data.universe.length > 0) {
              setSeries(normalize(data.universe as SeriesData[]));
              setHydrated(true);
              return;
            }
          }
        }
      } catch {
        // server not reachable — fall through to local
      }
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) setSeries(normalize(parsed as SeriesData[]));
        }
      } catch {
        // corrupted local storage
      }
      if (!cancelled) setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // persist locally on every change (cache + offline fallback)
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(series));
    } catch {
      try {
        const customOnly = series.filter((s) => s.source === "custom");
        localStorage.setItem(STORAGE_KEY, JSON.stringify(customOnly));
      } catch {
        // give up silently
      }
    }
  }, [series, hydrated]);

  // sync to server, debounced
  useEffect(() => {
    if (!hydrated || !serverConfigured) return;
    const t = setTimeout(() => {
      fetch("/api/universe", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ universe: series }),
      }).catch(() => {
        // network blip — local cache still has it; will retry next change
      });
    }, 1200);
    return () => clearTimeout(t);
  }, [series, hydrated, serverConfigured]);

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
  function toggleHighlight(id: string) {
    setSeries((prev) =>
      prev.map((s) => (s.id === id ? { ...s, highlighted: !s.highlighted } : s)),
    );
  }
  function reorder(draggedId: string, targetId: string) {
    setSeries((prev) => {
      const i = prev.findIndex((s) => s.id === draggedId);
      const j = prev.findIndex((s) => s.id === targetId);
      if (i < 0 || j < 0 || i === j) return prev;
      const next = [...prev];
      const [moved] = next.splice(i, 1);
      next.splice(j, 0, moved);
      return next;
    });
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
        onToggleHighlight={toggleHighlight}
        onReorder={reorder}
        storageBadge={
          hydrated
            ? serverConfigured
              ? "compartido"
              : "solo local"
            : "..."
        }
      />
      <ChartPanel series={activeSeries} />
    </main>
  );
}
