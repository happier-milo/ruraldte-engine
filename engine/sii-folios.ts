// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Pide, re-descarga y consulta folios (CAF) directo contra el portal de timbraje
 * electrónico del SII, sin proveedor intermedio.
 *
 * Maneja el portal clásico `cvc_cgi` como lo haría un navegador: sesión mTLS con el
 * PFX del emisor más el auth de `cgi_AUT2000`, y después cadenas de forms HTML que se
 * parsean y re-postean. El mTLS sale de `Deno.createHttpClient`, así que en Node o Bun
 * falla de inmediato con un `RuralDteFolioError` de `stage: "mtls"`. `ambiente` es 0
 * para Maullín (certificación) y 1 para Palena (producción).
 *
 * Ojo con la asimetría: `consultarFoliosViaRuralDte`, `redownloadCafViaRuralDte` y
 * `reobtenerCafViaRuralDte` no otorgan folios ni consumen cupo — la consulta incluso
 * lee `MAX_AUTOR`/`FOLIOS_DISP` desde la página de solicitud, pero jamás postea el
 * botón de otorgamiento, y esos dos campos son best-effort (vienen `null` si la página
 * no se pudo leer). `requestCafViaRuralDte` sí timbra: si falla, revisa `reachedGrant`
 * — en true el POST de otorgamiento ya salió y los folios pueden existir aunque no
 * tengas el XML, así que mira el portal antes de reintentar. El CAF vuelve como XML
 * crudo: validarlo, registrarlo y custodiarlo es tarea tuya.
 *
 * @example
 * ```ts
 * import {
 *   consultarFoliosViaRuralDte,
 *   requestCafViaRuralDte,
 *   RuralDteFolioError,
 * } from "@ruraldte/engine/sii-folios";
 *
 * const pfxBase64 = Deno.env.get("PFX_B64")!;
 * const pfxPassword = Deno.env.get("PFX_PASS")!;
 * const cred = { emisorRut: "76543210-K", ambiente: 0 as const, pfxBase64, pfxPassword };
 *
 * const { results } = await consultarFoliosViaRuralDte({ ...cred, documentTypes: [33] });
 * const cupo = results[0].maxTimbrar; // best-effort: null si no se pudo leer la página
 * if (cupo == null || cupo < 1) throw new Error("sin máximo a timbrar legible");
 *
 * try {
 *   // pedir más que el máximo autorizado suele terminar en rechazo del SII
 *   const { cafXml } = await requestCafViaRuralDte({ ...cred, documentType: 33, cantidad: cupo });
 *   await Deno.writeTextFile("caf-33.xml", cafXml); // CAF crudo: validarlo y custodiarlo es tuyo
 * } catch (err) {
 *   if (err instanceof RuralDteFolioError && err.reachedGrant) {
 *     console.error("puede haber folios otorgados: revisa el portal antes de reintentar", err.stage);
 *   }
 *   throw err;
 * }
 * ```
 *
 * @module
 */
// ============================================================================
// sii-folios.ts — Folios (CAF) al SII por el motor propio RuralDTE.
// ============================================================================
//
// Reemplaza la dependencia del oráculo de calibración para el Timbraje Electrónico del SII.
// Replica el portal cvc_cgi (reverse-engineered VIVO contra Maullín 2026-06-12,
// ver docs/RURALDTE_FOLIO_REQUEST_DESIGN.md §9.6). Dos capacidades:
//
//   • requestCafViaRuralDte  → SOLICITA + otorga folios (muta, devuelve CAF XML).
//   • consultarFoliosViaRuralDte → CONSULTA timbrajes históricos (read-only): qué
//     rangos tiene autorizados el emisor en el SII, por tipo de documento.
//
// Ambas comparten la sesión web clásica del SII:
//   1. mTLS: el PFX del emisor como CERTIFICADO CLIENTE TLS (Deno.createHttpClient).
//   2. Auth: POST herculesr/cgi_AUT2000/CAutInicio.cgi?<ref> body referencia=<ref>
//      → cookies de sesión (TOKEN/CSESSIONID). herculesr es el host de auth en
//      cert Y prod. El auth hace ~1/3 hiccup de TLS → openSiiSession reintenta.
//
// SEGURIDAD: en requestCaf el grant real ocurre en el paso de confirmación.
// `reachedGrant` indica si llegamos ahí — el orquestador NO debe caer al oráculo de calibración
// si reachedGrant=true (evita doble otorgamiento). La consulta es read-only.
// ============================================================================

import { extractPemFromPkcs12 } from "./pkcs12.ts";

const AUTH_ENDPOINT = "https://herculesr.sii.cl/cgi_AUT2000/CAutInicio.cgi";
const SII_USER_AGENT = "Mozilla/4.0 (compatible; PROG 1.0; rural-saas-dte)";

/** Host base del portal cvc_cgi por ambiente. */
function baseHost(ambiente: 0 | 1): string {
  return ambiente === 1 ? "https://palena.sii.cl" : "https://maullin.sii.cl";
}

/**
 * Parámetros de una operación de folios contra el portal de timbraje del SII.
 * `cantidad` solo la usa `requestCafViaRuralDte`: en la re-descarga y en la re-obtención
 * el rango va por parámetro aparte y ese campo se ignora.
 */
export type RuralDteFolioArgs = {
  /** RUT del emisor (empresa) con guión, ej "78416626-0". */
  emisorRut: string;
  documentType: number;
  cantidad: number;
  /** 0 = certificación (Maullín) · 1 = producción (Palena). */
  ambiente: 0 | 1;
  pfxBase64: string;
  pfxPassword: string;
};

/**
 * Retorno exitoso de `requestCafViaRuralDte`: `cafXml` es el `<AUTORIZACION>…</AUTORIZACION>`
 * recortado de la respuesta del SII, sin validar ni registrar. Acá `reachedGrant` viene siempre
 * en `true`; el valor que sirve para decidir un reintento es `RuralDteFolioError.reachedGrant`,
 * porque los fracasos se lanzan, no se devuelven.
 */
export type RuralDteFolioResult = {
  cafXml: string;
  reachedGrant: boolean;
  trace: TraceEntry[];
};

/**
 * Etapa del flujo en que se cortó la operación, la que reporta `RuralDteFolioError.stage`.
 * `"mtls"`, `"auth"` y `"form"` son siempre previas al otorgamiento; en `"grant"` y `"parse"`
 * hay que mirar `reachedGrant` antes de reintentar.
 */
export type FolioStage = "mtls" | "auth" | "form" | "grant" | "parse";

/**
 * Error tipado de las operaciones de folios: trae la `stage` donde se cortó, el `trace` de
 * la sesión y `reachedGrant`. Con `reachedGrant` en `true` el POST de otorgamiento ya salió
 * y los folios pueden existir en el SII aunque no tengas el XML: revisa el portal antes de
 * reintentar, o timbras dos veces.
 */
export class RuralDteFolioError extends Error {
  stage: FolioStage;
  reachedGrant: boolean;
  trace: TraceEntry[];
  constructor(
    stage: FolioStage,
    message: string,
    reachedGrant: boolean,
    trace: TraceEntry[],
  ) {
    super(message);
    this.name = "RuralDteFolioError";
    this.stage = stage;
    this.reachedGrant = reachedGrant;
    this.trace = trace;
  }
}

/**
 * Un paso HTTP de la sesión, guardado para diagnóstico. Los cuerpos que superan los 8.000
 * caracteres (request) o 16.000 (respuesta) se recortan a cabeza + cola, y el de la respuesta
 * final de un timbraje trae el CAF completo, llave privada incluida: trátalo como material
 * sensible al persistirlo o loguearlo.
 */
type TraceEntry = { step: string; status: number; url: string; reqBody?: string; body?: string };

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Extrae action + campos (input/select) del PRIMER form del HTML. Para select
 * toma el option `selected` o el primero. */
/** Detecta la página de ERROR explícita del SII en el timbraje ("No ha sido posible
 * completar su solicitud. Inténtelo más tarde" + código tipo LIBRUD-OFSF-DTE-3-1-02).
 * Devuelve { code } si es esa página (code null si no se pudo extraer); null si NO lo es. */
export function parseSiiFolioErrorPage(body: string): { code: string | null } | null {
  if (!/No ha sido posible completar/i.test(body)) return null;
  return { code: body.match(/\b([A-Z]{4,}-[A-Z]{2,}-[A-Z]{2,}-[\d.-]+)\b/)?.[1] ?? null };
}

/**
 * Extrae el `action` y los campos del PRIMER `<form>` del HTML del portal cvc_cgi.
 * Incluye los `input` de tipo `submit` —el portal confirma el timbraje con un botón y sin él
 * la página se re-postea a sí misma— y descarta `button`/`reset`; de cada `<select>` toma el
 * `option` marcado `selected` y, si no hay ninguno, el primero con `value`.
 *
 * @param html HTML de la página; si no trae `<form>`, los campos se buscan en todo el documento.
 * @returns El `action` tal cual viene en el atributo (`""` si el form no lo trae o si no hay
 * form; resuélvelo con `SiiSession.abs`) y los campos listos para re-postear.
 */
export function parseForm(html: string): { action: string; fields: Record<string, string> } {
  const formMatch = html.match(/<form\b[^>]*>([\s\S]*?)<\/form>/i);
  const formTag = html.match(/<form\b[^>]*>/i)?.[0] ?? "";
  const action = formTag.match(/action\s*=\s*["']?([^"'\s>]+)/i)?.[1] ?? "";
  const inner = formMatch?.[1] ?? html;
  const fields: Record<string, string> = {};
  // inputs (text/hidden/select Y submit). El submit se INCLUYE: el cvc_cgi confirma
  // el timbraje con un botón (ej. ACEPTAR="Confirmar Folio Inicial" en el 1er timbraje
  // de un tipo) y sin él la página de confirmación re-postea a sí misma en loop.
  // Excluimos button/reset (no son datos del envío).
  for (const m of inner.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = tag.match(/name\s*=\s*["']?([^"'\s>]+)/i)?.[1];
    const type = (tag.match(/type\s*=\s*["']?([^"'\s>]+)/i)?.[1] ?? "text").toLowerCase();
    if (!name || type === "button" || type === "reset") continue;
    // value con o sin comillas (FOLIO_INICIAL viene como value=1, sin comillas).
    const vm = tag.match(/value\s*=\s*["']([^"']*)["']/i) ?? tag.match(/value\s*=\s*([^\s>"']+)/i);
    fields[name] = vm?.[1] ?? "";
  }
  // selects (option selected, o el primero con value)
  for (const m of inner.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = m[1].match(/name\s*=\s*["']?([^"'\s>]+)/i)?.[1];
    if (!name) continue;
    const sel = m[2].match(/<option\b[^>]*\bselected\b[^>]*value\s*=\s*["']?([^"'\s>]+)/i) ??
      m[2].match(/<option\b[^>]*value\s*=\s*["']?([^"'\s>]+)/i);
    fields[name] = sel?.[1] ?? "";
  }
  return { action, fields };
}

/** Extrae el CAF (<AUTORIZACION>…</AUTORIZACION>) si está en la respuesta. */
function extractCaf(text: string): string | null {
  const m = text.match(/<AUTORIZACION[\s\S]*?<\/AUTORIZACION>/i);
  if (m && /<TD>\d+<\/TD>/.test(m[0]) && /<D>\d+<\/D>/.test(m[0])) return m[0];
  return null;
}

// ── Sesión SII (mTLS + auth, compartida por solicitud y consulta) ──────────────

/**
 * Respuesta cruda de un paso de `SiiSession.fetch`. `location` sale del header porque los
 * redirects no se siguen, y `body` es el texto ya leído (`""` si la lectura falló).
 */
type SiiResponse = { status: number; location: string | undefined; body: string };
/**
 * Sesión autenticada al portal cvc_cgi que entrega `openSiiSession`. Su `fetch` arrastra el
 * jar de cookies, NO sigue redirects (los devuelve en `location`) y anota cada paso en `trace`;
 * `abs` antepone `base` a toda ruta que no empiece con `http`, y `has`/`cookies` inspeccionan
 * el jar.
 */
export type SiiSession = {
  base: string;
  trace: TraceEntry[];
  abs: (path: string) => string;
  fetch: (step: string, url: string, init?: RequestInit) => Promise<SiiResponse>;
  has: (cookie: string) => boolean;
  cookies: () => string[];
};

/** Crea el cliente mTLS con el PFX del emisor. Throwea stage "mtls". */
function makeMtlsClient(pfxBase64: string, pfxPassword: string, trace: TraceEntry[]): unknown {
  try {
    const { certPem, pkeyPem } = extractPemFromPkcs12(b64ToBytes(pfxBase64), pfxPassword);
    // Por `globalThis` y no por el identificador `Deno` pelado: en Node/Bun ese
    // identificador NO existe y la referencia tira ReferenceError, así que este
    // guard —escrito justamente para degradar con gracia— terminaba reportando
    // "Deno is not defined" en vez de su propio mensaje. Con globalThis el
    // chequeo dice lo que quiso decir siempre.
    const createHttpClient = (globalThis as {
      Deno?: { createHttpClient?: (o: { cert: string; key: string }) => unknown };
    }).Deno?.createHttpClient;
    if (typeof createHttpClient !== "function") {
      throw new Error("Deno.createHttpClient no disponible (sin mTLS en este runtime)");
    }
    return createHttpClient({ cert: certPem, key: pkeyPem });
  } catch (err) {
    throw new RuralDteFolioError("mtls", err instanceof Error ? err.message : String(err), false, trace);
  }
}

/** Sesión con jar de cookies fresco sobre un cliente mTLS dado. */
function makeSession(client: unknown, base: string, trace: TraceEntry[]): SiiSession {
  const jar = new Map<string, string>();
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const fetchFn = async (step: string, url: string, init: RequestInit = {}): Promise<SiiResponse> => {
    const resp = await fetch(url, {
      ...init,
      headers: {
        "User-Agent": SII_USER_AGENT,
        ...(jar.size ? { Cookie: cookieHeader() } : {}),
        ...((init.headers as Record<string, string>) ?? {}),
      },
      redirect: "manual",
      client,
    } as RequestInit & { client: unknown });
    const setCookie = typeof (resp.headers as { getSetCookie?: () => string[] }).getSetCookie ===
        "function"
      ? (resp.headers as { getSetCookie: () => string[] }).getSetCookie()
      : (resp.headers.get("set-cookie") ? [resp.headers.get("set-cookie") as string] : []);
    for (const c of setCookie) {
      const nv = c.split(";")[0];
      const eq = nv.indexOf("=");
      if (eq > 0) jar.set(nv.slice(0, eq).trim(), nv.slice(eq + 1).trim());
    }
    const body = await resp.text().catch(() => "");
    // Captura para diagnóstico (dte_cert_sii_log): el cuerpo de RESPUESTA y el de la
    // REQUEST (qué POSTeamos). Las páginas cvc_cgi son chicas (<5KB) → se guardan
    // enteras; solo se truncan (cabeza+cola) respuestas patológicamente grandes.
    const cap = (s: string, n: number) =>
      s.length > n ? `${s.slice(0, n / 2)}…[${s.length}b]…${s.slice(-(n / 2))}` : s;
    const reqBody = typeof init.body === "string" ? init.body : undefined;
    trace.push({
      step,
      status: resp.status,
      url,
      ...(reqBody ? { reqBody: cap(reqBody, 8000) } : {}),
      body: cap(body, 16000),
    });
    return { status: resp.status, location: resp.headers.get("location") ?? undefined, body };
  };
  return {
    base,
    trace,
    abs: (path: string) => (path.startsWith("http") ? path : `${base}${path}`),
    fetch: fetchFn,
    has: (cookie: string) => jar.has(cookie),
    cookies: () => [...jar.keys()],
  };
}

/** Autentica una sesión contra el SII (mTLS ya activo) usando `referenceUrl` como
 * la URL de retorno del portal. Throwea si no quedó cookie de sesión. */
async function authenticate(session: SiiSession, referenceUrl: string): Promise<void> {
  await session.fetch("auth", `${AUTH_ENDPOINT}?${referenceUrl}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ referencia: referenceUrl }).toString(),
  });
  // Seguir la cadena de redirects de vuelta (acumula la sesión).
  let next: string | undefined = (await session.fetch("auth_follow", referenceUrl)).location;
  for (let i = 0; next && i < 5; i++) {
    next = (await session.fetch(`auth_hop${i}`, session.abs(next))).location;
  }
  if (!session.has("TOKEN") && !session.has("CSESSIONID")) {
    throw new Error(`auth sin cookie de sesión (cookies: ${session.cookies().join(",")})`);
  }
}

/**
 * Abre una sesión autenticada al portal cvc_cgi del SII: mTLS con el PFX del
 * emisor + auth cgi_AUT2000 contra `referenceUrl`. El auth del SII hace ~1/3
 * hiccup de TLS → reintenta con jar fresco (seguro: el auth es siempre pre-grant).
 */
export async function openSiiSession(
  args: { pfxBase64: string; pfxPassword: string; ambiente: 0 | 1 },
  referenceUrl: string,
  attempts = 3,
): Promise<SiiSession> {
  const trace: TraceEntry[] = [];
  const client = makeMtlsClient(args.pfxBase64, args.pfxPassword, trace); // throws stage mtls
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const session = makeSession(client, baseHost(args.ambiente), trace);
    try {
      await authenticate(session, referenceUrl);
      return session;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new RuralDteFolioError(
    "auth",
    `auth falló tras ${attempts} intentos: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    false,
    trace,
  );
}

// ── Solicitud (otorga folios) ──────────────────────────────────────────────────

/**
 * Pide y otorga un CAF al SII vía el motor propio (timbraje). Devuelve el CAF XML
 * crudo (el caller lo valida + registra con `registerCaf`). Throwea
 * `RuralDteFolioError` con `stage`/`reachedGrant` para el ruteo del orquestador.
 */
export async function requestCafViaRuralDte(
  args: RuralDteFolioArgs,
): Promise<RuralDteFolioResult> {
  const base = baseHost(args.ambiente);
  const folioUrl = `${base}/cvc_cgi/dte/of_solicita_folios`;

  // 1-2. mTLS + auth (con reintento). Throwea stage mtls/auth.
  const session = await openSiiSession(args, folioUrl);
  const { trace } = session;
  let reachedGrant = false;

  // 3-4. of_solicita_folios (RUT) → form tipo/cantidad.
  let dctoForm: { action: string; fields: Record<string, string> };
  try {
    const [rut, dv] = args.emisorRut.replace(/\./g, "").split("-");
    await session.fetch("folio_page", folioUrl);
    const dcto = await session.fetch("post_rut", session.abs("/cvc_cgi/dte/of_solicita_folios_dcto"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ RUT_EMP: rut, DV_EMP: dv ?? "0", ACEPTAR: "Continuar" }).toString(),
    });
    dctoForm = parseForm(dcto.body);
    if (!dctoForm.action) {
      throw new Error("no se encontró el form de tipo/cantidad (¿RUT no autorizado a timbrar?)");
    }
    // El SII puebla FACTOR / CON_CREDITO / CON_AJUSTE (y MAX_AUTOR / FOLIOS_DISP)
    // recién al SELECCIONAR el documento: el onChange del <select COD_DOCTO> dispara
    // changeRegregion(), que RE-ENVÍA el form a of_solicita_folios_dcto con el
    // COD_DOCTO elegido. Sin esa recarga esos campos van vacíos y el SII rechaza la
    // generación del PRIMER timbraje (of_genera_folio) con ST-SEG-DTE-21-2. La
    // replicamos: re-POST a of_solicita_folios_dcto con el tipo, sin ACEPTAR (un
    // form.submit() por JS no envía el botón) → devuelve el form con los campos
    // del documento poblados.
    const reloadFields: Record<string, string> = {
      ...dctoForm.fields,
      RUT_EMP: rut,
      DV_EMP: dv ?? "0",
      COD_DOCTO: String(args.documentType),
    };
    delete reloadFields.ACEPTAR;
    const reload = await session.fetch("post_doc", session.abs("/cvc_cgi/dte/of_solicita_folios_dcto"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(reloadFields).toString(),
    });
    const reloadForm = parseForm(reload.body);
    if (reloadForm.action) dctoForm = reloadForm;
  } catch (err) {
    if (err instanceof RuralDteFolioError) throw err;
    throw new RuralDteFolioError("form", err instanceof Error ? err.message : String(err), false, trace);
  }

  // 5-6. of_confirma_folio (tipo+cantidad) → confirmación → CAF. ← GRANT.
  try {
    const [rut, dv] = args.emisorRut.replace(/\./g, "").split("-");
    const grantFields: Record<string, string> = {
      ...dctoForm.fields,
      RUT_EMP: rut,
      DV_EMP: dv ?? "0",
      COD_DOCTO: String(args.documentType),
      CANT_DOCTOS: String(args.cantidad),
      // exenta (41) = N, afecta (39) = S (lo que el JS changeRegregion setearía).
      AFECTO_IVA: args.documentType === 41 ? "N" : "S",
      ACEPTAR: "Solicitar Numeración",
    };
    reachedGrant = true; // a partir de acá un POST puede otorgar folios.
    let resp = await session.fetch("post_confirma", session.abs(dctoForm.action), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(grantFields).toString(),
    });

    // Seguir el form de confirmación hasta encontrar el CAF (máx 3 hops).
    let caf = extractCaf(resp.body);
    for (let i = 0; !caf && i < 3; i++) {
      const cf = parseForm(resp.body);
      if (!cf.action) break;
      resp = await session.fetch(`post_confirm${i}`, session.abs(cf.action), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(cf.fields).toString(),
      });
      caf = extractCaf(resp.body);
    }
    if (!caf) {
      // ¿Página de ERROR EXPLÍCITA del SII? (ej. "No ha sido posible completar su
      // solicitud. Inténtelo más tarde" + código LIBRUD-OFSF-DTE-3-1-02, típico al
      // pedir MÁS que el máximo autorizado a timbrar). Si es así, el grant NO ocurrió
      // → reachedGrant=false (sin riesgo de huérfano) y damos un mensaje accionable.
      const siiErr = parseSiiFolioErrorPage(resp.body);
      if (siiErr) {
        throw new RuralDteFolioError(
          "grant",
          `el SII rechazó la solicitud de folios${siiErr.code ? ` (código ${siiErr.code})` : ""}: ` +
            `"No ha sido posible completar su solicitud, inténtelo más tarde". Causa típica: pediste MÁS ` +
            `que el máximo autorizado a timbrar (revisalo con "Sincronizar con el SII") o el SII está ` +
            `saturado. NO se otorgaron folios.`,
          false, // página de error explícita → no hubo grant, no hay huérfano
          trace,
        );
      }
      throw new RuralDteFolioError(
        "parse",
        `no se encontró el CAF en la respuesta final (status ${resp.status}, ${resp.body.length}b). ` +
          `Puede que el grant SÍ haya ocurrido — revisar en el portal antes de reintentar.`,
        reachedGrant,
        trace,
      );
    }
    return { cafXml: caf, reachedGrant, trace };
  } catch (err) {
    if (err instanceof RuralDteFolioError) throw err;
    throw new RuralDteFolioError("grant", err instanceof Error ? err.message : String(err), reachedGrant, trace);
  }
}

/**
 * Re-descarga el CAF de un rango YA timbrado vía of_genera_archivo. Recupera folios
 * otorgados pero no registrados (p. ej. si un grant cortó después de timbrar). El
 * archivo es DETERMINISTA por RUT+tipo+rango+fecha → NO timbra de nuevo ni consume
 * cupo del "máximo autorizado". `fecha` = AAAA-MM-DD del timbraje.
 */
export async function redownloadCafViaRuralDte(
  args: RuralDteFolioArgs,
  folioIni: number,
  folioFin: number,
  fecha: string,
): Promise<{ cafXml: string; trace: TraceEntry[] }> {
  const base = baseHost(args.ambiente);
  const session = await openSiiSession(args, `${base}/cvc_cgi/dte/of_solicita_folios`);
  const { trace } = session;
  const [rut, dv] = args.emisorRut.replace(/\./g, "").split("-");
  const resp = await session.fetch("genera_archivo", session.abs("/cvc_cgi/dte/of_genera_archivo"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      RUT_EMP: rut,
      DV_EMP: dv ?? "0",
      COD_DOCTO: String(args.documentType),
      FOLIO_INI: String(folioIni),
      FOLIO_FIN: String(folioFin),
      FECHA: fecha,
      ACEPTAR: "AQUI",
    }).toString(),
  });
  const caf = extractCaf(resp.body);
  if (!caf) {
    throw new RuralDteFolioError(
      "parse",
      `re-descarga sin CAF (status ${resp.status}, ${resp.body.length}b)`,
      false,
      trace,
    );
  }
  return { cafXml: caf, trace };
}

/**
 * Re-OBTIENE el CAF de un rango ya timbrado vía el flujo OFICIAL del SII
 * `rf_reobtencion1_folios` (Reobtención de Folios): lista los rangos timbrados →
 * "Reobtener" el rango → "Solicitar folios" → "AQUÍ" descarga el CAF. Determinista,
 * NO consume cupo del máximo autorizado. Para onboarding de emisores con folios
 * previos o recuperar un grant que no se registró.
 *
 * Las páginas son forms encadenados del cvc_cgi (como el grant); seguimos el form
 * inyectando el rango buscado hasta encontrar el <AUTORIZACION>. Instrumentado: el
 * trace captura cada página para afinar nombres de campo contra el HTML real.
 */
export async function reobtenerCafViaRuralDte(
  args: RuralDteFolioArgs,
  folioIni: number,
  folioFin: number,
): Promise<{ cafXml: string; trace: TraceEntry[] }> {
  const base = baseHost(args.ambiente);
  const session = await openSiiSession(args, `${base}/cvc_cgi/dte/rf_reobtencion1_folios`);
  const { trace } = session;
  const [rut, dv] = args.emisorRut.replace(/\./g, "").split("-");
  const idFields = {
    RUT_EMP: rut,
    DV_EMP: dv ?? "0",
    COD_DOCTO: String(args.documentType),
    FOLIO_INI: String(folioIni),
    FOLIO_FIN: String(folioFin),
    FOLIO_INICIAL: String(folioIni),
    FOLIO_FINAL: String(folioFin),
  };
  // 1. Página de re-obtención (lista los rangos timbrados del tipo para el RUT).
  let resp = await session.fetch("reob_page", session.abs("/cvc_cgi/dte/rf_reobtencion1_folios"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ RUT_EMP: rut, DV_EMP: dv ?? "0", COD_DOCTO: String(args.documentType) }).toString(),
  });
  // 2-N. Seguir el form encadenado (Reobtener → Solicitar folios → AQUÍ) inyectando
  // el rango buscado, hasta encontrar el CAF (máx 5 hops).
  let caf = extractCaf(resp.body);
  for (let i = 0; !caf && i < 5; i++) {
    const f = parseForm(resp.body);
    if (!f.action) break;
    resp = await session.fetch(`reob_step${i}`, session.abs(f.action), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...f.fields, ...idFields }).toString(),
    });
    caf = extractCaf(resp.body);
  }
  if (!caf) {
    throw new RuralDteFolioError(
      "parse",
      `re-obtención sin CAF (status ${resp.status}, ${resp.body.length}b)`,
      false,
      trace,
    );
  }
  return { cafXml: caf, trace };
}

// ── Consulta (read-only: timbrajes históricos autorizados) ─────────────────────

/** Un timbraje histórico (rango autorizado) de of_consulta2_folio. */
export type ConsultaFolioBatch = {
  fecha: string;
  cantidad: number;
  folioInicial: number;
  folioFinal: number;
  mandatario: string;
};

/** Resultado de la consulta para un tipo de documento. */
export type ConsultaFolioResult = {
  documentType: number;
  /** false = el emisor no tiene habilitado ese tipo para timbrar. */
  enabled: boolean;
  documentName: string | null;
  batches: ConsultaFolioBatch[];
  /** Σ folios autorizados (Σ folioFinal-folioInicial+1). */
  authorizedTotal: number;
  /** Folio más alto autorizado (0 si ninguno). */
  authorizedMax: number;
  /** Máximo de folios que el SII autoriza a timbrar AHORA (MAX_AUTOR de
   * of_solicita_folios_dcto). null = no se pudo leer la página de solicitud. */
  maxTimbrar?: number | null;
  /** Folios disponibles / sin usar según el SII (FOLIOS_DISP). null = no leído. */
  foliosSinUsar?: number | null;
};

/** Parsea la respuesta de of_consulta2_folio. Tres formas: tabla con timbrajes,
 * "No registra timbrajes" (enabled, 0), "no tiene habilitado" (no enabled). */
function parseConsulta(html: string): { enabled: boolean; documentName: string | null; batches: ConsultaFolioBatch[] } {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const enabled = !/no\s+tiene\s+habilitado/i.test(text);
  // Nombre del documento desde el texto plano (sin tags/entidades): el SII lo
  // pone como "… para <NOMBRE>:" (habilitado) o "documento <NOMBRE> para …" (no).
  const flat = text.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ");
  const documentName = (enabled
    ? flat.match(/\bpara\s+([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9 .\/]+?)\s*:/i)?.[1]
    : flat.match(/\bdocumento\s+([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9 .\/]+?)\s+para\b/i)?.[1])
    ?.replace(/\s+/g, " ").trim() ?? null;
  const batches: ConsultaFolioBatch[] = [];
  for (const row of text.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
    const cells = [...row[0].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((c) => c[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
    if (cells.length < 5) continue;
    const fecha = cells[0];
    if (!/^\d{2}-\d{2}-\d{4}$/.test(fecha)) continue; // salta header y títulos
    const folioInicial = parseInt(cells[2].replace(/\D/g, ""), 10);
    const folioFinal = parseInt(cells[3].replace(/\D/g, ""), 10);
    if (!Number.isFinite(folioInicial) || !Number.isFinite(folioFinal) || folioFinal < folioInicial) continue;
    const cantidad = parseInt(cells[1].replace(/\D/g, ""), 10);
    batches.push({
      fecha,
      cantidad: Number.isFinite(cantidad) ? cantidad : folioFinal - folioInicial + 1,
      folioInicial,
      folioFinal,
      mandatario: cells[4],
    });
  }
  return { enabled, documentName, batches };
}

/**
 * Consulta los timbrajes históricos del emisor en el SII (read-only) para cada
 * tipo de documento. Abre UNA sesión mTLS+auth y consulta cada tipo. Devuelve los
 * rangos autorizados — el caller los reconcilia contra dte_folios_caf.
 */
export async function consultarFoliosViaRuralDte(args: {
  emisorRut: string;
  documentTypes: number[];
  ambiente: 0 | 1;
  pfxBase64: string;
  pfxPassword: string;
}): Promise<{ results: ConsultaFolioResult[]; trace: TraceEntry[] }> {
  const base = baseHost(args.ambiente);
  const consultaUrl = `${base}/cvc_cgi/dte/of_consulta_folios`;
  const session = await openSiiSession(args, consultaUrl); // throws stage mtls/auth
  const [rut, dv] = args.emisorRut.replace(/\./g, "").split("-");
  // Aterriza en el form de consulta (refresca el contexto de sesión).
  await session.fetch("consulta_form", consultaUrl).catch(() => {});

  const results: ConsultaFolioResult[] = [];
  for (const documentType of args.documentTypes) {
    const batches: ConsultaFolioBatch[] = [];
    const seen = new Set<string>();
    let enabled = true;
    let documentName: string | null = null;
    for (let pagina = 1; pagina <= 12; pagina++) {
      let body = "";
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        try {
          const r = await session.fetch("consulta2", session.abs("/cvc_cgi/dte/of_consulta2_folio"), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              RUT_EMP: rut,
              DV_EMP: dv ?? "0",
              COD_DOCTO: String(documentType),
              PAGINA: String(pagina),
              ACEPTAR: "Consultar",
            }).toString(),
          });
          body = r.body;
          ok = true;
        } catch (err) {
          if (attempt === 1) {
            throw new RuralDteFolioError(
              "form",
              `consulta tipo ${documentType} pág ${pagina}: ${err instanceof Error ? err.message : String(err)}`,
              false,
              session.trace,
            );
          }
        }
      }
      const parsed = parseConsulta(body);
      enabled = parsed.enabled;
      documentName = parsed.documentName;
      if (!parsed.enabled) break;
      let added = 0;
      for (const b of parsed.batches) {
        const key = `${b.fecha}|${b.folioInicial}|${b.folioFinal}`;
        if (seen.has(key)) continue;
        seen.add(key);
        batches.push(b);
        added++;
      }
      if (added === 0) break; // sin filas nuevas → no hay más páginas
    }
    const authorizedTotal = batches.reduce((s, b) => s + (b.folioFinal - b.folioInicial + 1), 0);
    const authorizedMax = batches.reduce((m, b) => Math.max(m, b.folioFinal), 0);
    results.push({ documentType, enabled, documentName, batches, authorizedTotal, authorizedMax });
  }

  // ── Máximo a timbrar (MAX_AUTOR) + folios sin usar (FOLIOS_DISP) por tipo ──
  // El SII los expone en of_solicita_folios_dcto recién tras el reload con el
  // COD_DOCTO (lo que dispara changeRegregion() en el navegador). Se leen en la
  // MISMA sesión y SIN otorgar (jamás se postea ACEPTAR="Solicitar Numeración").
  // Best-effort: si la página de solicitud falla, la consulta igual sirve.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    await session.fetch("solicita_land", session.abs("/cvc_cgi/dte/of_solicita_folios")).catch(() => {});
    const rutResp = await session.fetch("solicita_rut", session.abs("/cvc_cgi/dte/of_solicita_folios_dcto"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ RUT_EMP: rut, DV_EMP: dv ?? "0", ACEPTAR: "Continuar" }).toString(),
    });
    const baseFields = parseForm(rutResp.body).fields;
    for (let i = 0; i < args.documentTypes.length; i++) {
      const documentType = args.documentTypes[i];
      const target = results.find((r) => r.documentType === documentType);
      try {
        const reloadFields: Record<string, string> = {
          ...baseFields,
          RUT_EMP: rut,
          DV_EMP: dv ?? "0",
          COD_DOCTO: String(documentType),
        };
        delete reloadFields.ACEPTAR;
        const reload = await session.fetch(
          `solicita_doc_${documentType}`,
          session.abs("/cvc_cgi/dte/of_solicita_folios_dcto"),
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(reloadFields).toString(),
          },
        );
        const f = parseForm(reload.body).fields;
        const max = parseInt((f.MAX_AUTOR ?? "").trim(), 10);
        const disp = parseInt((f.FOLIOS_DISP ?? "").trim(), 10);
        if (target) {
          target.maxTimbrar = Number.isFinite(max) ? max : null;
          target.foliosSinUsar = Number.isFinite(disp) ? disp : null;
        }
      } catch (err) {
        if (target) {
          target.maxTimbrar = null;
          target.foliosSinUsar = null;
        }
        // Los null son un resultado legítimo (el SII no expuso los cupos), pero sin
        // dejar el motivo NO se distingue "no los expuso" de "se cayó la página".
        // Queda en el trace, que es justo lo que esta función devuelve para diagnosticar.
        session.trace.push({
          step: `solicita_doc_${documentType}_error`,
          status: 0,
          url: session.abs("/cvc_cgi/dte/of_solicita_folios_dcto"),
          body: err instanceof Error ? err.message : String(err),
        });
      }
      if (i < args.documentTypes.length - 1) await sleep(1500); // espaciar (gentil con el SII)
    }
  } catch (err) {
    // Best-effort de verdad: los `results` ya están y se devuelven igual. Pero el
    // motivo va al trace en vez de desaparecer — un cupo que llega en null sin
    // explicación manda a buscar el problema al lado equivocado.
    session.trace.push({
      step: "solicita_cupos_error",
      status: 0,
      url: session.abs("/cvc_cgi/dte/of_solicita_folios"),
      body: err instanceof Error ? err.message : String(err),
    });
  }

  return { results, trace: session.trace };
}
