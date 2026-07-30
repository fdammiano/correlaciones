"use client";

// Estado compartido de las relaciones long-short (el Monitor las muestra, el
// Radar las agrega). Vive en localStorage + un store de suscriptores en memoria
// para que todas las instancias del hook se actualicen al instante, sin depender
// de eventos del DOM.

import { useCallback, useEffect, useState } from "react";

export const RELATIONS_KEY = "correlations-app:relations:v1";

export type Relation = { id: string; longId: string; shortId: string };

// Suscriptores vivos (una función por instancia montada del hook).
const subs = new Set<(r: Relation[]) => void>();

function read(): Relation[] {
  try {
    if (typeof window === "undefined") return [];
    const raw = localStorage.getItem(RELATIONS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(next: Relation[]) {
  try {
    localStorage.setItem(RELATIONS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  // Notifica a TODAS las instancias montadas (Monitor, Radar, etc.).
  subs.forEach((fn) => fn(next));
}

function makeId(): string {
  return `r-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function useRelations() {
  const [relations, setRelations] = useState<Relation[]>([]);

  useEffect(() => {
    setRelations(read());
    const fn = (r: Relation[]) => setRelations(r);
    subs.add(fn);
    // También reacciona a cambios desde otra pestaña.
    const onStorage = (e: StorageEvent) => {
      if (e.key === RELATIONS_KEY) setRelations(read());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      subs.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  /** Agrega la relación (o devuelve la existente si ya estaba). */
  const add = useCallback((longId: string, shortId: string): string | null => {
    if (!longId || !shortId || longId === shortId) return null;
    const cur = read();
    const dup = cur.find((r) => r.longId === longId && r.shortId === shortId);
    if (dup) return dup.id;
    const id = makeId();
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

  return { relations, hydrated: true, add, remove, has };
}
