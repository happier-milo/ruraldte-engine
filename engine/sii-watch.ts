// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Helpers puros del watcher del SII: evalúa si un CAF amerita alerta, hashea bytes para detectar
 * drift y lista los recursos oficiales que hay que vigilar.
 *
 * Nada acá hace red ni disco: no descarga recursos, no guarda baselines ni despacha alertas — eso
 * lo pone quien lo consume. `evaluateCaf` recibe `nowMs` en vez de leer el reloj y alerta con dos
 * umbrales fijos (`CAF_EXPIRY_WARN_DAYS` 30 días, `CAF_LOW_FOLIOS` 10 folios); si `expires_at`
 * viene `null` no alerta NUNCA por vencimiento, solo por folios, y los restantes salen de
 * `used_count` contra el rango, así que un folio quemado que no llegó al contador no se ve. El
 * catálogo es un array estático —agregar un recurso obliga a redesplegar a quien lo empaqueta— y
 * `aduana.anexo51` es un HTML grande: si lo hasheas crudo, un cambio cosmético del sitio te da un
 * falso positivo. `SII_GLOBAL_TABLES` sí necesita token y se baja con `getGlobalTable` de
 * `@ruraldte/engine/sii-client`.
 *
 * @example
 * ```ts
 * import { evaluateCaf, sha256Hex, SII_PUBLIC_RESOURCES } from "@ruraldte/engine/sii-watch";
 *
 * const ev = evaluateCaf({
 *   id: "caf-39-001",
 *   community_id: "11111111-2222-3333-4444-555555555555",
 *   document_type: 39,
 *   range_start: 1,
 *   range_end: 100,
 *   used_count: 95,
 *   expires_at: "2026-06-25T00:00:00Z",
 * }, Date.parse("2026-06-09T12:00:00Z"));
 * // ev.alert === true · ev.daysToExpiry === 15 · ev.remaining === 5
 * if (ev.alert) console.warn(ev.reasons.join(" · "));
 *
 * // Drift de un recurso público: bajas el archivo, lo hasheas y lo comparas con tu baseline.
 * const xsd = SII_PUBLIC_RESOURCES.find((r) => r.key === "xsd.dte")!;
 * const hash = await sha256Hex(new Uint8Array(await (await fetch(xsd.url)).arrayBuffer()));
 * ```
 *
 * @module
 */
// ============================================================================
// _shared/dte/sii-watch.ts — helpers puros del watcher SII (#7).
//
// Lógica testeable separada del edge fn (que hace I/O): evaluación de CAF,
// hashing SHA-256, y el catálogo de recursos SII a vigilar.
// ============================================================================

import type { GlobalTable } from "./sii-client.ts";

// ---------------------------------------------------------------------------
// CAF
// ---------------------------------------------------------------------------

/**
 * Días de anticipación con que `evaluateCaf` avisa que un CAF está por vencer: 30.
 * Solo gatilla el aviso preventivo — un CAF ya vencido alerta siempre, sin importar el umbral.
 * Es un valor fijo del módulo, no un parámetro: para otro margen, compara tú mismo el
 * `daysToExpiry` que devuelve `evaluateCaf`.
 */
export const CAF_EXPIRY_WARN_DAYS = 30;
/**
 * Umbral de folios disponibles en o bajo el cual `evaluateCaf` levanta alerta: 10.
 * La cuenta viene de `remainingFolios`, que no hace clamp: un CAF agotado (0) o sobre-consumido
 * (restantes negativos) también queda bajo el umbral y alerta.
 */
export const CAF_LOW_FOLIOS = 10;

/**
 * CAF tal como lo leen `remainingFolios` y `evaluateCaf`: rango de folios otorgado, folios ya
 * consumidos y fecha de vencimiento.
 * `range_start`/`range_end` son inclusivos y los restantes salen de `used_count`, así que un folio
 * quemado que no alcanzó a incrementar el contador se sigue viendo como disponible. `expires_at`
 * va en ISO-8601 (se parsea con `new Date` y se recorta a `YYYY-MM-DD` para la glosa); en `null` el
 * CAF no alerta nunca por vencimiento, solo por folios. `id`, `community_id` y `document_type` no
 * los mira ninguna de las dos funciones: viajan para que quien reciba la alerta sepa de qué CAF
 * habla.
 */
export type CafRow = {
  id: string;
  community_id: string;
  document_type: number;
  range_start: number;
  range_end: number;
  used_count: number;
  expires_at: string | null;
};

/**
 * Folios que le quedan al CAF: el largo del rango, con ambos extremos incluidos, menos los
 * consumidos. No hace clamp — si `used_count` pasó el rango, el resultado es negativo.
 *
 * @param caf CAF con su rango otorgado y el contador de folios usados.
 * @returns Folios disponibles; 0 o menos cuando el CAF ya se agotó.
 */
export function remainingFolios(caf: CafRow): number {
  return (caf.range_end - caf.range_start + 1) - caf.used_count;
}

/**
 * Evalúa si un CAF amerita alerta: vencido / por vencer (<=30d) o con pocos
 * folios (<=10). `nowMs` se inyecta para testear sin reloj.
 */
export function evaluateCaf(
  caf: CafRow,
  nowMs: number,
): { alert: boolean; daysToExpiry: number | null; remaining: number; reasons: string[] } {
  const remaining = remainingFolios(caf);
  const reasons: string[] = [];
  let daysToExpiry: number | null = null;

  if (caf.expires_at) {
    daysToExpiry = Math.floor((new Date(caf.expires_at).getTime() - nowMs) / 86_400_000);
    if (daysToExpiry < 0) {
      reasons.push(`CAF VENCIDO hace ${-daysToExpiry}d (${caf.expires_at.slice(0, 10)})`);
    } else if (daysToExpiry <= CAF_EXPIRY_WARN_DAYS) {
      reasons.push(`CAF vence en ${daysToExpiry}d (${caf.expires_at.slice(0, 10)})`);
    }
  }
  if (remaining <= CAF_LOW_FOLIOS) {
    reasons.push(`quedan ${remaining} folios`);
  }

  return { alert: reasons.length > 0, daysToExpiry, remaining, reasons };
}

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

/** SHA-256 hex de un buffer (para detectar drift de specs). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Catálogo de recursos SII a vigilar
// ---------------------------------------------------------------------------

/** Recursos PÚBLICOS (sin token): openapi del canal boleta + XSD oficiales. */
export const SII_PUBLIC_RESOURCES: ReadonlyArray<{ key: string; url: string; label: string }> = [
  {
    key: "openapi.boleta",
    url: "https://www4c.sii.cl/bolcoreinternetui/api/openapi.json",
    label: "OpenAPI canal boleta (bolcoreinternetui)",
  },
  {
    key: "xsd.envio_bol",
    url: "https://www.sii.cl/factura_electronica/factura_mercado/schema_envio_bol.zip",
    label: "XSD EnvioBOLETA (schema_envio_bol.zip)",
  },
  {
    key: "xsd.dte",
    url: "https://www.sii.cl/factura_electronica/factura_mercado/schema_dte.zip",
    label: "XSD DTE (schema_dte.zip)",
  },
  {
    key: "xsd.libro_bol",
    url: "https://www.sii.cl/factura_electronica/factura_mercado/schema_libro_bol.zip",
    label: "XSD Libro Boletas (schema_libro_bol.zip)",
  },
  // Tablas de códigos OFICIALES que alimentan el motor (drift EXTERNO → revisar el .ts citado).
  // El XSD del DTE (xsd.dte arriba) ya cubre SiiTypes_v10/ImpAdicDTEType → sii-codigos.ts.
  // El drift INTERNO (el .ts ≠ su baseline revisado) lo cubre scripts/check-dte-codes-drift.ts.
  // NOTA: el Anexo 51 es un HTML grande; se hashea crudo → un cambio cosmético (banner/fecha) puede
  // dar un falso positivo P1. Es barato y auto-sanable (el humano revisa, no hay cambio de código, y
  // checkResource re-guarda el baseline → no re-alerta). Si genera ruido, extraer las celdas 51-* antes
  // de hashear. Agregar/editar estos recursos requiere REDEPLOY de dte-sii-watcher (no es dato dinámico).
  {
    key: "aduana.anexo51",
    url: "https://www.aduana.cl/compendio-de-normas-anexo-51/aduana/2009-11-19/163937.html",
    label: "Anexo 51 Aduana — países/puertos/bultos/monedas/cláusulas/etc. (revisar aduana-codes.ts)",
  },
  {
    key: "sii.oficinas",
    url: "https://www.sii.cl/transparencia/oficinas_atencion.html",
    label: "Directorio oficinas SII — jurisdicción comuna→oficina (revisar sii-oficinas.mjs)",
  },
];

/** Tablas /globales/* (requieren token; fuente de verdad de los códigos de estado). */
export const SII_GLOBAL_TABLES: ReadonlyArray<GlobalTable> = [
  "envio.estado",
  "estado",
  "nivel",
  "seccion",
  "tipo",
];
