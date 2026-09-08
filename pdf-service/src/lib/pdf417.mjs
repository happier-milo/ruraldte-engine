// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// pdf417.mjs — Timbre Electrónico PDF417 del TED de un DTE (Componente E).
// ============================================================================
//
// Reglas del SII (Instructivo Emisión Doctos, ANEXO 2, A.2.5 "Reglas Para La
// Generación e Impresión Del Timbre PDF417"):
//   – Byte Compaction Mode (modo binario) — OBLIGATORIO, para no romper los
//     caracteres especiales (acentos/ñ) del TED.
//   – Error Correction Level (ECL) = 5.
//   – X Dim mínimo 6,7 mils; Row Height (Y Dim) en relación 3:1 con X Dim.
//   – Tamaño impreso objetivo: máx 3 cm alto × 9 cm ancho; quiet zone ≥ 0,25";
//     negro sobre blanco, sin "truncated".
//
// IMPLEMENTACIÓN: usamos el writer de `zxing-wasm` (motor Zint). Con entrada
// BINARIA (Uint8Array) fuerza Byte Compaction completa — verificado round-trip
// byte-a-byte con acentos AISLADOS, que es justo el caso que `bwip-js` rompe
// (text-compaction + byte-shift 913 que los lectores zxing mal-decodifican).
// La salida es un SVG vectorial (un único <path> de módulos) que pdf-lib dibuja
// nítido con drawSvgPath a cualquier tamaño de impresión.
//
// El TED se entrega como string ya en su forma de transmisión ISO-8859-1; cada
// code point 0–255 se mapea 1:1 a su byte.
// ============================================================================

import { writeBarcode, setZXingModuleOverrides } from "zxing-wasm/writer";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Cargar el .wasm del writer LOCALMENTE (sin fetch a CDN). El default de zxing-wasm hace fetch del
// binario wasm; sin red (box/local con outbound bloqueado) falla con "both async and sync fetching of
// the wasm failed". Resolvemos el .wasp del paquete y lo pasamos como wasmBinary (robusto offline).
try {
  const req = createRequire(import.meta.url);
  const writerEntry = req.resolve("zxing-wasm/writer"); // …/zxing-wasm/dist/es/writer/index.js
  const wasmPath = join(dirname(writerEntry), "../../writer/zxing_writer.wasm"); // …/dist/writer/zxing_writer.wasm
  setZXingModuleOverrides({ wasmBinary: readFileSync(wasmPath) });
} catch { /* fallback: zxing-wasm usa su carga por defecto (fetch) */ }

const POINTS_PER_CM = 72 / 2.54; // 28.3465 pt/cm
export const TIMBRE_MAX_W_PT = 9 * POINTS_PER_CM; // ≤ 9 cm
export const TIMBRE_MAX_H_PT = 3 * POINTS_PER_CM; // ≤ 3 cm
const MIN_X_DIM_MILS = 6.7; // SII: X Dim mínimo

/** Opciones del writer = el contrato SII (Byte Compaction + ECL 5). */
export const PDF417_WRITER_OPTS = Object.freeze({ format: "PDF417", ecLevel: "5" });

/** String → bytes ISO-8859-1 (cada char 0–255 = 1 byte). */
export function toLatin1Bytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Codifica el TED como símbolo PDF417 (Byte Compaction + ECL 5). Devuelve el
 * resultado crudo de zxing-wasm (svg vectorial + image PNG). Expuesto para tests
 * de round-trip; los callers usan buildTedPdf417 (geometría vectorial).
 * @param {string} tedXml
 */
export async function encodeTedBarcode(tedXml) {
  if (typeof tedXml !== "string" || tedXml.length === 0) {
    throw new Error("encodeTedBarcode: tedXml vacío");
  }
  const res = await writeBarcode(toLatin1Bytes(tedXml), PDF417_WRITER_OPTS);
  if (res.error) throw new Error(`encodeTedBarcode: zxing error: ${res.error}`);
  return res;
}

/**
 * Genera el timbre PDF417 del TED como geometría vectorial (módulos en unidades
 * de "módulo": 1 unidad SVG = 1 módulo).
 * @param {string} tedXml  El `<TED>…</TED>` completo (forma Latin-1).
 * @returns {Promise<{ width:number, height:number, path:string }>}
 *   width/height en módulos; `path` = el atributo `d` del <path> (coords y hacia
 *   abajo, comandos M/h/v/Z) listo para `page.drawSvgPath`.
 */
export async function buildTedPdf417(tedXml) {
  const res = await encodeTedBarcode(tedXml);
  const svg = res.svg ?? "";
  const width = Number(svg.match(/width="(\d+)"/)?.[1]);
  const height = Number(svg.match(/height="(\d+)"/)?.[1]);
  const path = svg.match(/<path d="([^"]+)"/)?.[1];
  if (!width || !height || !path) {
    throw new Error("buildTedPdf417: no se pudo parsear el SVG del timbre");
  }
  return { width, height, path };
}

/**
 * Genera el timbre PDF417 del TED como imagen RASTER (PNG, 1px por módulo). Es
 * la forma que el SII RECOMIENDA (manual muestras §1.5: "lo ideal es imágenes
 * PNG incrustadas... el software del SII las reconoce más rápido"). Embebida con
 * `drawImage` y `/Interpolate=false` (default de pdf-lib) el visor escala por
 * vecino-más-cercano → módulos nítidos que decodifican a cualquier resolución,
 * evitando el aliasing del trazo vectorial a escalas fraccionarias.
 * @param {string} tedXml  El `<TED>…</TED>` completo (forma Latin-1).
 * @returns {Promise<{ png:Uint8Array, width:number, height:number }>}
 *   png = bytes PNG; width/height en módulos (= píxeles del PNG).
 */
const PDF417_PNG_SCALE = 4; // px por módulo del PNG (alta-res → decode robusto a cualquier DPI)

export async function buildTedPdf417Png(tedXml) {
  if (typeof tedXml !== "string" || tedXml.length === 0) {
    throw new Error("buildTedPdf417Png: tedXml vacío");
  }
  const res = await writeBarcode(toLatin1Bytes(tedXml), { ...PDF417_WRITER_OPTS, scale: PDF417_PNG_SCALE });
  if (res.error) throw new Error(`buildTedPdf417Png: zxing error: ${res.error}`);
  const svg = res.svg ?? "";
  // Con scale>0 el SVG reporta PÍXELES (escala × módulos); módulos = px / escala.
  const pxW = Number(svg.match(/width="(\d+)"/)?.[1]);
  const pxH = Number(svg.match(/height="(\d+)"/)?.[1]);
  if (!res.image || !pxW || !pxH) {
    throw new Error("buildTedPdf417Png: zxing no devolvió imagen/dimensiones");
  }
  const png = new Uint8Array(await res.image.arrayBuffer());
  return { png, width: pxW / PDF417_PNG_SCALE, height: pxH / PDF417_PNG_SCALE };
}

/**
 * Calcula el tamaño de dibujo (en puntos PDF) del timbre dentro de la envolvente
 * SII (≤ 9 cm × 3 cm), preservando el aspecto. El alto es la restricción que
 * suele mandar; el X Dim resultante se reporta para verificar el mínimo (6,7 mils).
 * @param {{width:number,height:number}} bc  dimensiones en módulos
 * @returns {{ drawW:number, drawH:number, scale:number, xDimMils:number }}
 */
export function fitTimbre(bc) {
  const scale = Math.min(TIMBRE_MAX_W_PT / bc.width, TIMBRE_MAX_H_PT / bc.height);
  const drawW = bc.width * scale;
  const drawH = bc.height * scale;
  // X Dim = ancho impreso por módulo. 1 pt = 1/72 in = 1000/72 mils.
  const xDimMils = (drawW / bc.width) * (1000 / 72);
  return { drawW, drawH, scale, xDimMils };
}

export { MIN_X_DIM_MILS };
