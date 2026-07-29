import { NextResponse } from "next/server";
import { deleteMsToken, isStoreConfigured, loadMsTokenMeta, saveMsToken } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Contraseña opcional para proteger la escritura del token. Si no está
// configurada (MS_TOKEN_PASSWORD), cualquiera con la página puede actualizarlo.
function passwordRequired(): boolean {
  return !!process.env.MS_TOKEN_PASSWORD;
}

// GET → estado del token. NUNCA devuelve el valor del token.
export async function GET() {
  if (!isStoreConfigured()) {
    return NextResponse.json({
      configured: false,
      hasToken: false,
      updatedAt: null,
      requiresPassword: passwordRequired(),
    });
  }
  const meta = await loadMsTokenMeta();
  return NextResponse.json({
    configured: true,
    ...meta,
    requiresPassword: passwordRequired(),
  });
}

// PUT → guarda un token nuevo. Body: { token, password? }
export async function PUT(req: Request) {
  if (!isStoreConfigured()) {
    return NextResponse.json(
      { error: "Almacenamiento no configurado (falta KV/Redis)." },
      { status: 503 },
    );
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const token =
    typeof (body as { token?: unknown })?.token === "string"
      ? ((body as { token: string }).token).trim()
      : "";
  if (!token) {
    return NextResponse.json({ error: "Falta el token." }, { status: 400 });
  }

  const needed = process.env.MS_TOKEN_PASSWORD;
  if (needed) {
    const given = (body as { password?: unknown })?.password;
    if (given !== needed) {
      return NextResponse.json({ error: "Contraseña incorrecta." }, { status: 401 });
    }
  }

  const updatedAt = new Date().toISOString();
  const ok = await saveMsToken(token, updatedAt);
  if (!ok) {
    return NextResponse.json({ error: "No se pudo guardar el token." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, updatedAt });
}

// DELETE → borra el token guardado (misma protección por contraseña que PUT).
export async function DELETE(req: Request) {
  if (!isStoreConfigured()) {
    return NextResponse.json({ error: "Almacenamiento no configurado." }, { status: 503 });
  }
  const needed = process.env.MS_TOKEN_PASSWORD;
  if (needed) {
    let body: unknown = null;
    try {
      body = await req.json();
    } catch {
      // sin body
    }
    if ((body as { password?: unknown })?.password !== needed) {
      return NextResponse.json({ error: "Contraseña incorrecta." }, { status: 401 });
    }
  }
  const ok = await deleteMsToken();
  if (!ok) {
    return NextResponse.json({ error: "No se pudo borrar el token." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
