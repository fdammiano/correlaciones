import { Redis } from "@upstash/redis";

const KEY = "correlations:universe:default";
const MS_TOKEN_KEY = "correlations:ms:token";

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

// ── Token de Morningstar ──
// El token de Morningstar Direct vence cada 24 h. Lo guardamos en KV (no en
// una env var) para poder actualizarlo desde la página sin redeploy. Se
// serializa como { token, updatedAt }; la función Python de /api/morningstar
// lo lee vía la REST API de Upstash.
export type MsTokenMeta = { hasToken: boolean; updatedAt: string | null };

function unwrap(raw: unknown): { token?: string; updatedAt?: string } {
  let obj: unknown = raw;
  // @upstash puede devolver el objeto ya parseado o como string JSON.
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return { token: obj as string };
    }
  }
  if (obj && typeof obj === "object") {
    return obj as { token?: string; updatedAt?: string };
  }
  return {};
}

export async function loadMsTokenMeta(): Promise<MsTokenMeta> {
  const c = client();
  if (!c) return { hasToken: false, updatedAt: null };
  try {
    const raw = await c.get<unknown>(MS_TOKEN_KEY);
    if (raw == null) return { hasToken: false, updatedAt: null };
    const { token, updatedAt } = unwrap(raw);
    return { hasToken: !!token, updatedAt: updatedAt ?? null };
  } catch (e) {
    console.error("loadMsTokenMeta failed", e);
    return { hasToken: false, updatedAt: null };
  }
}

export async function saveMsToken(token: string, updatedAt: string): Promise<boolean> {
  const c = client();
  if (!c) return false;
  try {
    await c.set(MS_TOKEN_KEY, JSON.stringify({ token, updatedAt }));
    return true;
  } catch (e) {
    console.error("saveMsToken failed", e);
    return false;
  }
}

export async function deleteMsToken(): Promise<boolean> {
  const c = client();
  if (!c) return false;
  try {
    await c.del(MS_TOKEN_KEY);
    return true;
  } catch (e) {
    console.error("deleteMsToken failed", e);
    return false;
  }
}
