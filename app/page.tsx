"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import UniverseBuilder from "@/components/UniverseBuilder";
import ChartPanel from "@/components/ChartPanel";
import type { SeriesData, ReturnPoint } from "@/lib/types";

// Re-baja los retornos de una serie que tiene fuente "viva" (Fama French o Yahoo)
// para incorporar los meses recientes. El id ya codifica de dónde viene:
//   FF     → `${datasetId}::${columna}`
//   Yahoo  → `yahoo::${ticker}`
async function fetchFreshReturns(s: SeriesData): Promise<ReturnPoint[] | null> {
  try {
    if (s.source === "french") {
      const sep = s.id.indexOf("::");
      if (sep < 0) return null;
      const datasetId = s.id.slice(0, sep);
      const col = s.id.slice(sep + 2);
      const res = await fetch(`/api/french/dataset?name=${encodeURIComponent(datasetId)}`);
      if (!res.ok) return null;
      const data = await res.json();
      const idx: number = (data.columns ?? []).indexOf(col);
      if (idx < 0) return null;
      return (data.rows ?? [])
        .map((r: { date: string; values: (number | null)[] }) => ({
          date: r.date,
          value: r.values[idx],
        }))
        .filter((p: { value: number | null }) => p.value != null) as ReturnPoint[];
    }
    if (s.source === "yahoo") {
      const ticker = s.id.startsWith("yahoo::") ? s.id.slice("yahoo::".length) : "";
      if (!ticker) return null;
      const res = await fetch(`/api/yahoo?ticker=${encodeURIComponent(ticker)}`);
      if (!res.ok) return null;
      const data = await res.json();
      return (data.returns ?? []) as ReturnPoint[];
    }
  } catch {
    // silencioso: si falla el refresh, se queda con lo que ya tenía
  }
  return null;
}

const STORAGE_KEY = "correlations-app:series:v1";
const COLLECTIONS_KEY = "correlations-app:collections:v1";
const ACTIVE_TAB_KEY = "correlations-app:activeTab:v1";
const MASTER = "master";

// Una colección es una selección con nombre de activos del maestro.
// Se guarda SOLO en el navegador del usuario (privada); el maestro es lo compartido.
type Collection = { id: string; name: string; ids: string[] };

function normalize(parsed: SeriesData[]): SeriesData[] {
  return parsed.map((s) => ({ ...s, active: s.active !== false }));
}

export default function Home() {
  const [series, setSeries] = useState<SeriesData[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [activeTab, setActiveTab] = useState<string>(MASTER);
  const [hydrated, setHydrated] = useState(false);
  const [serverConfigured, setServerConfigured] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Espejo siempre-actualizado de las series, para leerlas dentro de efectos
  // sin re-disparar el auto-refresh.
  const seriesRef = useRef<SeriesData[]>([]);
  seriesRef.current = series;
  const refreshedRef = useRef(false);

  // hydrate maestro: prefer server (shared), fall back to localStorage (per-browser)
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

  // hydrate colecciones + pestaña activa (siempre local, por navegador)
  useEffect(() => {
    try {
      const rawC = localStorage.getItem(COLLECTIONS_KEY);
      if (rawC) {
        const p = JSON.parse(rawC);
        if (Array.isArray(p)) setCollections(p as Collection[]);
      }
      const rawT = localStorage.getItem(ACTIVE_TAB_KEY);
      if (rawT) setActiveTab(rawT);
    } catch {
      // ignore
    }
  }, []);

  // persist maestro locally on every change (cache + offline fallback)
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

  // persist colecciones + pestaña (local only)
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(COLLECTIONS_KEY, JSON.stringify(collections));
    } catch {
      // ignore
    }
  }, [collections, hydrated]);
  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_TAB_KEY, activeTab);
    } catch {
      // ignore
    }
  }, [activeTab]);

  // sync maestro to server, debounced
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

  // Auto-refresh al abrir: re-baja FF/Yahoo para incorporar meses recientes.
  useEffect(() => {
    if (!hydrated || refreshedRef.current) return;
    refreshedRef.current = true;
    const live = seriesRef.current.filter(
      (s) => s.source === "french" || s.source === "yahoo",
    );
    if (live.length === 0) return;
    setRefreshing(true);
    (async () => {
      const fresh = new Map<string, ReturnPoint[]>();
      await Promise.all(
        live.map(async (s) => {
          const r = await fetchFreshReturns(s);
          if (r && r.length) fresh.set(s.id, r);
        }),
      );
      if (fresh.size > 0) {
        setSeries((prev) =>
          prev.map((s) => (fresh.has(s.id) ? { ...s, returns: fresh.get(s.id)! } : s)),
        );
      }
      setRefreshing(false);
    })();
  }, [hydrated]);

  const currentCollection = useMemo(
    () => collections.find((c) => c.id === activeTab) ?? null,
    [collections, activeTab],
  );
  const isCollection = currentCollection !== null;

  // si la pestaña apunta a una colección borrada, volver al maestro
  useEffect(() => {
    if (activeTab !== MASTER && !collections.some((c) => c.id === activeTab)) {
      setActiveTab(MASTER);
    }
  }, [collections, activeTab]);

  // viewSeries: el flag `active` refleja la pestaña actual
  //  - maestro     → active tal como está guardado (compartido)
  //  - colección X → active = pertenece a la colección X (local)
  const viewSeries = useMemo(() => {
    if (!currentCollection) return series;
    const memberSet = new Set(currentCollection.ids);
    return series.map((s) => ({ ...s, active: memberSet.has(s.id) }));
  }, [series, currentCollection]);

  const activeSeries = useMemo(
    () => viewSeries.filter((s) => s.active !== false),
    [viewSeries],
  );

  // agregar: siempre al maestro; si estás en una colección, además se suma como miembro
  function add(newOnes: SeriesData[]) {
    setSeries((prev) => {
      const map = new Map(prev.map((s) => [s.id, s]));
      newOnes.forEach((s) => map.set(s.id, { ...s, active: true }));
      return Array.from(map.values());
    });
    if (currentCollection) {
      const addIds = newOnes.map((s) => s.id);
      setCollections((prev) =>
        prev.map((c) =>
          c.id === currentCollection.id
            ? { ...c, ids: Array.from(new Set([...c.ids, ...addIds])) }
            : c,
        ),
      );
    }
  }

  function remove(id: string) {
    if (currentCollection) {
      // en una colección, ✕ solo quita el activo de esa colección (no borra el maestro)
      setCollections((prev) =>
        prev.map((c) =>
          c.id === currentCollection.id ? { ...c, ids: c.ids.filter((x) => x !== id) } : c,
        ),
      );
    } else {
      // en el maestro, ✕ borra el activo de verdad (y de todas las colecciones)
      setSeries((prev) => prev.filter((s) => s.id !== id));
      setCollections((prev) => prev.map((c) => ({ ...c, ids: c.ids.filter((x) => x !== id) })));
    }
  }

  function toggleActive(id: string) {
    if (currentCollection) {
      setCollections((prev) =>
        prev.map((c) => {
          if (c.id !== currentCollection.id) return c;
          return c.ids.includes(id)
            ? { ...c, ids: c.ids.filter((x) => x !== id) }
            : { ...c, ids: [...c.ids, id] };
        }),
      );
    } else {
      setSeries((prev) =>
        prev.map((s) => (s.id === id ? { ...s, active: s.active === false } : s)),
      );
    }
  }

  function setAllActive(active: boolean) {
    if (currentCollection) {
      setCollections((prev) =>
        prev.map((c) =>
          c.id === currentCollection.id
            ? { ...c, ids: active ? series.map((s) => s.id) : [] }
            : c,
        ),
      );
    } else {
      setSeries((prev) => prev.map((s) => ({ ...s, active })));
    }
  }

  function activateOnly(ids: string[]) {
    if (currentCollection) {
      setCollections((prev) =>
        prev.map((c) => (c.id === currentCollection.id ? { ...c, ids: [...ids] } : c)),
      );
    } else {
      const set = new Set(ids);
      setSeries((prev) => prev.map((s) => ({ ...s, active: set.has(s.id) })));
    }
  }

  function invertActive() {
    if (currentCollection) {
      const memberSet = new Set(currentCollection.ids);
      const inverted = series.filter((s) => !memberSet.has(s.id)).map((s) => s.id);
      setCollections((prev) =>
        prev.map((c) => (c.id === currentCollection.id ? { ...c, ids: inverted } : c)),
      );
    } else {
      setSeries((prev) => prev.map((s) => ({ ...s, active: s.active === false })));
    }
  }

  function clearCurrent() {
    if (currentCollection) {
      setCollections((prev) =>
        prev.map((c) => (c.id === currentCollection.id ? { ...c, ids: [] } : c)),
      );
    } else {
      setSeries([]);
    }
  }

  function toggleHighlight(id: string) {
    setSeries((prev) =>
      prev.map((s) => (s.id === id ? { ...s, highlighted: !s.highlighted } : s)),
    );
  }

  // Reemplaza una serie existente por su versión editada (misma id),
  // preservando active/highlighted. Usado al editar una cartera.
  function updateSeries(updated: SeriesData) {
    setSeries((prev) =>
      prev.map((s) =>
        s.id === updated.id
          ? { ...s, name: updated.name, returns: updated.returns, portfolio: updated.portfolio }
          : s,
      ),
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

  // ── gestión de colecciones ──
  function newCollection() {
    const id = `col-${Date.now()}`;
    const n = collections.length + 1;
    setCollections((prev) => [...prev, { id, name: `Colección ${n}`, ids: [] }]);
    setActiveTab(id);
  }
  function renameActiveCollection(name: string) {
    if (!currentCollection) return;
    setCollections((prev) =>
      prev.map((c) => (c.id === currentCollection.id ? { ...c, name } : c)),
    );
  }
  function deleteActiveCollection() {
    if (!currentCollection) return;
    const cid = currentCollection.id;
    setCollections((prev) => prev.filter((c) => c.id !== cid));
    setActiveTab(MASTER);
  }
  // guarda la selección activa del maestro como nueva colección
  function saveActiveAsCollection() {
    const ids = series.filter((s) => s.active !== false).map((s) => s.id);
    const id = `col-${Date.now()}`;
    const n = collections.length + 1;
    setCollections((prev) => [...prev, { id, name: `Colección ${n}`, ids }]);
    setActiveTab(id);
  }

  const tabs = useMemo(() => {
    const master = { id: MASTER, name: "Maestro", count: series.length };
    const cols = collections.map((c) => ({
      id: c.id,
      name: c.name,
      count: c.ids.filter((id) => series.some((s) => s.id === id)).length,
    }));
    return [master, ...cols];
  }, [series, collections]);

  return (
    <main className="flex">
      <UniverseBuilder
        series={viewSeries}
        tabs={tabs}
        activeTabId={activeTab}
        isCollection={isCollection}
        collectionName={currentCollection?.name ?? ""}
        onSelectTab={setActiveTab}
        onNewCollection={newCollection}
        onSaveActiveAsCollection={saveActiveAsCollection}
        onRenameActiveCollection={renameActiveCollection}
        onDeleteActiveCollection={deleteActiveCollection}
        onAdd={add}
        onRemove={remove}
        onClear={clearCurrent}
        onToggleActive={toggleActive}
        onSetAllActive={setAllActive}
        onActivateOnly={activateOnly}
        onInvert={invertActive}
        onToggleHighlight={toggleHighlight}
        onUpdateSeries={updateSeries}
        onReorder={reorder}
        refreshing={refreshing}
        storageBadge={
          hydrated
            ? serverConfigured
              ? "compartido"
              : "solo local"
            : "..."
        }
      />
      <ChartPanel series={activeSeries} library={series} />
    </main>
  );
}
