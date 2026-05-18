import { Redis } from "@upstash/redis";

const KEY = "correlations:universe:default";

function envUrl(): string | undefined {
  return (
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.REDIS_URL
  );
}

function envToken(): string | undefined {
  return (
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

export function isStoreConfigured(): boolean {
  return !!envUrl() && !!envToken();
}

function client(): Redis | null {
  const url = envUrl();
  const token = envToken();
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function loadUniverse(): Promise<unknown[] | null> {
  const c = client();
  if (!c) return null;
  try {
    const raw = await c.get<unknown>(KEY);
    if (raw == null) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  } catch (e) {
    console.error("loadUniverse failed", e);
    return null;
  }
}

export async function saveUniverse(universe: unknown[]): Promise<boolean> {
  const c = client();
  if (!c) return false;
  try {
    await c.set(KEY, JSON.stringify(universe));
    return true;
  } catch (e) {
    console.error("saveUniverse failed", e);
    return false;
  }
}
