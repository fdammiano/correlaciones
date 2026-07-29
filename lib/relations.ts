"use client";

// Estado compartido de las relaciones long-short (el Monitor las muestra, el
// Radar las agrega). Vive en localStorage + un evento propio para que los dos
// componentes se mantengan sincronizados sin subir el estado hasta la página.

import { useCallback, useEffect, useState } from "react";

export const RELATIONS_KEY = "correlations-app:relations:v1";
const EVT = "correlations-app:relations-changed";

export type Relation = { id: string; longId: string; shortId: string };

function read(): Relation[] {
  try {
    const raw = localStorage.getItem(RELATIONS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(rels: Relation[]) {
  try {
    localStorage.setItem(RELATIONS_KEY, JSON.stringify(rels));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(EVT, { detail: rels }));
}

export function useRelations() {
  const [relations, setRelations] = useState<Relation[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setRelations(read());
    setHydrated(true);
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail as Relation[] | undefined;
      setRelations(Array.isArray(detail) ? detail : read());
    };
    window.addEventListener(EVT, onChange);
    return () => window.removeEventListener(EVT, onChange);
  }, []);

  /** Agrega la relación (o devuelve la existente si ya estaba). */
  const add = useCallback((longId: string, shortId: string): string | null => {
    if (!longId || !shortId || longId === shortId) return null;
    const cur = read();
    const dup = cur.find((r) => r.longId === longId && r.shortId === shortId);
    if (dup) return dup.id;
    const id = `r-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    write([...cur, { id, longId, shortId }]);
    return id;
  }, []);

  const remove = useCallback((id: string) => {
    write(read().filter((r) => r.id !== id));
  }, []);

  const has = useCallback(
    (longId: string, shortId: string) => relations.some((r) => r.longId === longId && r.shortId === shortId),
    [relations],
  );

  return { relations, hydrated, add, remove, has };
}
