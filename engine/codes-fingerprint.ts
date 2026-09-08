// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Huella estable de las tablas de códigos DTE (Aduana Anexo 51 + SII) para detectar drift.
 *
 * Cada tabla se serializa canónicamente antes de hashearla —claves ordenadas (numérico cuando ambas
 * son números) y arrays de primitivos ordenados—, así que reordenar entradas en el .ts no es drift y
 * cambiar un código o una glosa sí. Solo calcula la huella de las tablas que trae el paquete:
 * comparar contra tu baseline revisado es tarea tuya, y vigilar la publicación oficial del SII vive
 * afuera (el catálogo `SII_PUBLIC_RESOURCES` de `sii-watch`). Único falso negativo conocido: los
 * arrays de objetos mantienen el orden de inserción, aunque hoy ninguna tabla vigilada tiene uno.
 *
 * @example
 * ```ts
 * import { DTE_CODE_TABLES, fingerprintDteCodeTables, fingerprintTable } from "@ruraldte/engine/codes-fingerprint";
 *
 * const huellas = await fingerprintDteCodeTables();
 * console.log(huellas["sii-codigos"].TIPOS_DTE.count, huellas["aduana-codes"].PAISES.sha256);
 *
 * // Check puntual contra un baseline revisado a mano (guárdalo en un .json versionado):
 * const BASELINE_PAISES = "a1b2c3...";
 * const paises = await fingerprintTable(DTE_CODE_TABLES["aduana-codes"].PAISES);
 * if (paises.sha256 !== BASELINE_PAISES) throw new Error(`drift en PAISES: ${paises.count} claves`);
 * ```
 *
 * @module
 */
// ============================================================================
// _shared/dte/codes-fingerprint.ts — Fingerprint estable de las tablas de
// códigos DTE (Aduana Anexo 51 + SII formato_dte), para detección de DRIFT.
// ============================================================================
//
// Capa INTERNA del sistema anti-drift de códigos: produce, por tabla, un
// { count, sha256, keys } reproducible. El checker (scripts/check-dte-codes-drift.ts)
// y el test (dte-codes-baseline.test.ts) IMPORTAN este mismo helper → una sola
// canonicalización, imposible que diverjan (riesgo #3 del diseño).
//
// La capa EXTERNA (¿cambió la fuente oficial upstream?) la cubre el watcher
// `dte-sii-watcher` vía SII_PUBLIC_RESOURCES en `sii-watch.ts`.

import { sha256Hex } from "./sii-watch.ts";
import {
  CLAUSULA_VENTA,
  FORMAS_PAGO_EXP,
  MODALIDAD_VENTA,
  MONEDA_ISO_A_SII,
  MONEDAS_ADUANA,
  PAISES,
  PUERTOS,
  TIPOS_BULTO,
  UNIDADES_MEDIDA,
  VIA_TRANSPORTE,
} from "./aduana-codes.ts";
import {
  CDG_TRASLADO,
  FORMA_PAGO,
  IMPUESTOS_RETENCIONES,
  IND_SERVICIO,
  IND_TRASLADO,
  IVA_NO_RECUPERABLE,
  TIPOS_DOC_REFERENCIA,
  TIPOS_DTE,
} from "./sii-codigos.ts";

/** Huella de una tabla: cantidad de claves, SHA-256 del contenido canónico, y las claves ordenadas. */
export interface TableFingerprint {
  count: number;
  sha256: string;
  keys: string[];
}

/**
 * Serialización canónica y estable: ordena las claves de cada objeto (numérico
 * si ambas son números, si no alfabético) y ordena los arrays de primitivos.
 * Así el hash es invariante al ORDEN en que las entradas estén escritas en el .ts
 * (reordenar el literal NO cuenta como drift; cambiar valores/códigos SÍ).
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    // Solo ordenamos arrays de PRIMITIVOS (caso real: listas de comunas en OFICINA_COMUNAS,
    // order-insensitive). Arrays de objetos conservan orden de inserción — hoy NINGUNA tabla los
    // tiene; si en el futuro se agrega uno order-insensitive, ordenarlo acá o el reorden no se
    // detectaría como drift (falso negativo).
    const allPrim = value.every((x) => x === null || typeof x !== "object");
    const items = allPrim
      ? [...value].sort((a, b) => String(a).localeCompare(String(b)))
      : value;
    return "[" + items.map(stableStringify).join(",") + "]";
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(numericAwareCompare);
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

/** Orden numérico si ambas claves son números (101 < 1010), si no alfabético. */
function numericAwareCompare(a: string, b: string): number {
  const na = Number(a), nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b);
}

/** Claves de una tabla, ordenadas de forma estable (numérico-aware). */
function sortedKeys(table: Record<string, unknown>): string[] {
  return Object.keys(table).sort(numericAwareCompare);
}

/** Huella de una tabla individual. */
export async function fingerprintTable(table: Record<string, unknown>): Promise<TableFingerprint> {
  const keys = sortedKeys(table);
  const sha256 = await sha256Hex(new TextEncoder().encode(stableStringify(table)));
  return { count: keys.length, sha256, keys };
}

/** Catálogo de tablas DTE vigiladas, agrupadas por módulo (= secciones del baseline). */
export const DTE_CODE_TABLES: Record<string, Record<string, Record<string, unknown>>> = {
  "aduana-codes": {
    MONEDA_ISO_A_SII,
    MONEDAS_ADUANA,
    VIA_TRANSPORTE,
    MODALIDAD_VENTA,
    CLAUSULA_VENTA,
    PAISES,
    PUERTOS,
    FORMAS_PAGO_EXP,
    UNIDADES_MEDIDA,
    TIPOS_BULTO,
  },
  "sii-codigos": {
    TIPOS_DTE,
    FORMA_PAGO,
    IND_TRASLADO,
    IND_SERVICIO,
    CDG_TRASLADO,
    IVA_NO_RECUPERABLE,
    IMPUESTOS_RETENCIONES: IMPUESTOS_RETENCIONES as unknown as Record<string, unknown>,
    TIPOS_DOC_REFERENCIA,
  },
};

/** Huellas de todas las tablas DTE (aduana-codes + sii-codigos), por módulo y tabla. */
export async function fingerprintDteCodeTables(): Promise<
  Record<string, Record<string, TableFingerprint>>
> {
  const out: Record<string, Record<string, TableFingerprint>> = {};
  for (const [mod, tables] of Object.entries(DTE_CODE_TABLES)) {
    out[mod] = {};
    for (const [name, table] of Object.entries(tables)) {
      out[mod][name] = await fingerprintTable(table);
    }
  }
  return out;
}
