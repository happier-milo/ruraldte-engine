// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// factura-pdf.mjs — Representación impresa (muestra) de la familia FACTURA
// (33/34/46/52/56/61) conforme al "Manual de Muestras Impresas" v4.0 del SII.
//
// Es la etapa 4 de la certificación de factura ("Documentos Impresos"): el SII
// lee el timbre PDF417, verifica CAF + firma y revisa que la representación
// gráfica cumpla el formato. Reglas implementadas (manual_muestras_impresas.pdf):
//   – Recuadro de tipo de documento (arriba-derecha): R.U.T. emisor + NOMBRE del
//     tipo (mayúscula, ≤2 líneas) + N° de folio, en ROJO o NEGRO (NUNCA verde),
//     filete; bajo el recuadro "S.I.I. — <Unidad>" (Dirección Regional/Unidad).
//   – Emisor arriba-izquierda: Razón Social, Giro (sin abreviar), Casa Matriz,
//     Sucursales.
//   – Fecha de emisión (con ciudad) + Receptor (Razón Social, RUT, Giro,
//     Dirección, Comuna, Ciudad).
//   – Referencias (si corresponde): tipo en palabras, folio, fecha, motivo.
//   – Detalle (con descuentos por línea), Totales (Neto/Exento/IVA 19%/Total;
//     exenta = Monto Exento + Monto Total, sin Neto ni IVA).
//   – CEDIBLE: solo Factura / Factura Exenta / Guía / Factura de Compra llevan el
//     cuadro de Acuse de Recibo (Ley 19.983, Res. Ex. SII N°51/2005) + leyenda
//     "CEDIBLE" (guía: "CEDIBLE CON SU FACTURA"). NC/ND NUNCA llevan acuse ni
//     cedible. Guía de traslado interno / no-venta tampoco lleva cedible.
//   – Timbre PDF417 (Byte Compaction, ECL 5) abajo, ≥2 cm del borde izquierdo,
//     2×5 a 4×9 cm + caption "Timbre Electrónico SII" / "Res. N de AAAA -
//     Verifique documento: www.sii.cl".
//   – Todo el documento DEBE caber en UNA sola página (requisito del Upload).
//
// Función PURA (sin IO/Supabase); el handler HTTP vive en handlers/factura.mjs.
// Montos en pesos enteros (convención del proyecto).
// ============================================================================

import { readFileSync } from "node:fs";
import { degrees, PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { buildTedPdf417Png } from "./pdf417.mjs";
import { resolveSiiOficina } from "./sii-oficinas.mjs";

// Logo wordmark de Comunidad Rural (mismo PNG que los correos/boleta). El SII
// permite logo arriba-izquierda ≤1/5 del documento (manual de muestras §1.1.3).
// Sin el archivo simplemente no hay logo (la razón social encabeza el bloque).
let LOGO_WORDMARK_BYTES = null;
try {
  LOGO_WORDMARK_BYTES = readFileSync(new URL("../assets/logo-wordmark.png", import.meta.url));
} catch { /* sin logo */ }

// El logo de plataforma va SOLO en documentos de Comunidad Rural: para cualquier
// otro emisor el membrete queda sin logo — es un tercero y su razón social encabeza
// el bloque (decisión founder 2026-07-03; mismo param `plataforma` de la línea legal
// de boleta). Hay que DECLARAR la plataforma para llevarlo: antes el default hacía
// que no declarar nada equivaliera a declararse Comunidad Rural, y el logo de una
// marca ajena terminaba en el documento de quien solo quería un PDF.
function llevaLogoPlataforma(input) {
  return String(input?.plataforma || "") === "ComunidadRural";
}

const POINTS_PER_CM = 72 / 2.54; // 28.3465 pt/cm
const MILS_PER_PT = 1000 / 72;
// Envolvente del timbre (manual: mín 2×5 cm, máx 4×9 cm — alto×ancho).
const TIMBRE_MAX_W_PT = 9 * POINTS_PER_CM;
const TIMBRE_MAX_H_PT = 4 * POINTS_PER_CM;
const TIMBRE_MIN_W_PT = 5 * POINTS_PER_CM;
const TIMBRE_MIN_H_PT = 2 * POINTS_PER_CM;
const TIMBRE_MIN_LEFT_PT = 2 * POINTS_PER_CM; // ≥2 cm desde el borde izquierdo
const TARGET_XDIM_MILS = 8.0; // holgura sobre el mínimo SII (6.7); timbre raster nítido
export const MIN_X_DIM_MILS = 6.7;

const PAGE_W = 612; // LETTER
const PAGE_H = 792;
const MARGIN = 40;
const RIGHT = PAGE_W - MARGIN;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const DEFAULT_VERIFY = "www.sii.cl";

const C = {
  black: rgb(0, 0, 0),
  white: rgb(1, 1, 1),
  red: rgb(0.737, 0.231, 0.169), // #bc3b2b — recuadro SII (rojo de marca; NUNCA verde, Circular 32/2005)
  brandGreen: rgb(0.0824, 0.502, 0.2392), // #15803d
  deepGreen: rgb(0.0196, 0.1804, 0.0863), // #052e16 (barras de encabezado)
  cardBg: rgb(0.957, 0.976, 0.965), // #f4f9f6
  cardBorder: rgb(0.843, 0.902, 0.867), // #d7e6dd
  ink: rgb(0.1, 0.1, 0.1),
  gray: rgb(0.34, 0.34, 0.34),
  grayLabel: rgb(0.45, 0.45, 0.45),
  line: rgb(0.7, 0.7, 0.7),
  hairline: rgb(0.82, 0.82, 0.82),
};

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

// Nombre del tipo de documento para el recuadro (mayúscula, español, ≤2 líneas).
// (manual §1.1.4). Mapea también a "nombre en palabras" para Referencias.
const TIPO_DOC = {
  33: { box: ["FACTURA ELECTRÓNICA"], words: "Factura Electrónica", cedible: true },
  34: { box: ["FACTURA NO AFECTA O", "EXENTA ELECTRÓNICA"], words: "Factura No Afecta o Exenta Electrónica", cedible: true },
  46: { box: ["FACTURA DE COMPRA", "ELECTRÓNICA"], words: "Factura de Compra Electrónica", cedible: true },
  43: { box: ["LIQUIDACIÓN FACTURA", "ELECTRÓNICA"], words: "Liquidación Factura Electrónica", cedible: true },
  52: { box: ["GUÍA DE DESPACHO", "ELECTRÓNICA"], words: "Guía de Despacho Electrónica", cedible: true },
  56: { box: ["NOTA DE DÉBITO", "ELECTRÓNICA"], words: "Nota de Débito Electrónica", cedible: false },
  61: { box: ["NOTA DE CRÉDITO", "ELECTRÓNICA"], words: "Nota de Crédito Electrónica", cedible: false },
  // Exportación (manual §1.1.4). NO llevan ejemplar cedible. Montos en moneda extranjera (TpoMoneda).
  110: { box: ["FACTURA DE EXPORTACIÓN", "ELECTRÓNICA"], words: "Factura de Exportación Electrónica", cedible: false },
  111: { box: ["NOTA DE DÉBITO DE", "EXPORTACIÓN ELECTRÓNICA"], words: "Nota de Débito de Exportación Electrónica", cedible: false },
  112: { box: ["NOTA DE CRÉDITO DE", "EXPORTACIÓN ELECTRÓNICA"], words: "Nota de Crédito de Exportación Electrónica", cedible: false },
};

// Tipo de traslado de la Guía de Despacho (manual §1.4; tabla DTE). Las
// operaciones que NO constituyen venta o son traslado interno no llevan cedible.
const TRASLADO_VENTA = new Set([1, 9]); // 1 = constituye venta, 9 = venta exportación
const TRASLADO_LABEL = {
  1: "Operación constituye venta",
  2: "Ventas por efectuar",
  3: "Consignaciones",
  4: "Entrega gratuita",
  5: "Traslados internos",
  6: "Otros traslados no venta",
  7: "Guía de devolución",
  8: "Traslado para exportación (no venta)",
  9: "Venta para exportación",
};

const fmtCLP = (v) => "$ " + Math.round(Number(v) || 0).toLocaleString("es-CL");
const fmtNum = (v) => Math.round(Number(v) || 0).toLocaleString("es-CL");

/** "78416626-0" → "78.416.626-0". */
function fmtRut(rut) {
  if (!rut) return "";
  const m = String(rut).replace(/\./g, "").trim().match(/^(\d+)-?([0-9kK])$/);
  if (!m) return String(rut);
  return Number(m[1]).toLocaleString("es-CL") + "-" + m[2].toUpperCase();
}

/** "2026-06-14" → "14 de Junio de 2026". */
function fmtFechaLarga(iso) {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso ?? "");
  return `${Number(m[3])} de ${MESES[Number(m[2]) - 1]} de ${m[1]}`;
}

/** "2026-06-14" → "14/06/2026". */
function fmtFechaCorta(iso) {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso ?? "");
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** Año (AAAA) de un ISO o número. */
function yearOf(iso) {
  const m = String(iso ?? "").match(/(\d{4})/);
  return m ? m[1] : String(new Date().getFullYear());
}

/** Parte el texto en líneas que caben en maxW puntos (greedy por palabras). */
function wrapText(s, font, size, maxW) {
  const words = String(s ?? "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (font.widthOfTextAtSize(next, size) <= maxW || !cur) cur = next;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Path SVG de un rectángulo redondeado (origen top-left, y hacia abajo). */
function roundRectPath(w, h, r) {
  return `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} ` +
    `A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} ` +
    `V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
}

/**
 * @typedef {object} FacturaPdfItem
 * @property {string} [codigo]
 * @property {string} nombre
 * @property {number} cantidad
 * @property {string} [unidad]
 * @property {number} precio          precio unitario neto (pesos enteros)
 * @property {boolean} [exento]
 * @property {number} [descuentoPct]  descuento por línea en %
 * @property {number} [descuentoMonto] monto descuento (si no, se deriva del %)
 * @property {number} [valor]         valor de línea (si no, qty×precio−dscto)
 */

/**
 * @typedef {object} FacturaPdfInput
 * @property {33|34|46|52|56|61} tipoDte
 * @property {number} folio
 * @property {string} fechaEmision    ISO "AAAA-MM-DD"
 * @property {{rut:string, razonSocial:string, giro?:string, direccion?:string, comuna?:string, ciudad?:string, sucursal?:string, telefono?:string, email?:string}} emisor
 * @property {string} [siiUnidad]     Override de la Unidad/Oficina SII. Si se omite, se resuelve
 *                                    automáticamente desde emisor.comuna (resolveSiiOficina); si la
 *                                    comuna no está mapeada, cae al nombre de la comuna.
 * @property {{rut?:string, razonSocial?:string, giro?:string, direccion?:string, comuna?:string, ciudad?:string}} [receptor]
 * @property {FacturaPdfItem[]} items
 * @property {{neto?:number, exento?:number, iva?:number, tasaIva?:number, descuentoGlobal?:number, total:number}} totales
 * @property {{tipoDocRef:string, folioRef:number|string, fchRef?:string, codRef?:number, razonRef?:string}[]} [referencias]
 * @property {{tipoTraslado?:number}} [despacho]   guía 52: tipo de traslado (1–9)
 * @property {import("./boleta-pdf.mjs").Representacion} [representacion]
 *   Contenido EXTRA que el emisor define al emitir (mismo contrato genérico que
 *   la boleta). Nada de esto va al XML: es lo que el emisor necesita decirle a
 *   SU cliente en el papel y el formato DTE no contempla. El render dibuja
 *   etiqueta + valor YA FORMATEADO, sin saber qué significan.
 *
 *   Diferencia con la boleta: la factura no tiene franja de vencimiento, así que
 *   `leyendaVencimiento` se dibuja como una línea propia bajo los totales. Se
 *   dibuja igual —y no se descarta— porque perder en silencio algo que el
 *   emisor mandó es peor que ubicarlo distinto.
 * @property {string} tedXml          <TED>…</TED> para el PDF417
 * @property {{numero?:number|string, anio?:number|string}} [resolucion]  caption del timbre
 * @property {boolean} [cedible]      true = ejemplar cedible (acuse + CEDIBLE)
 * @property {string} [verifyUrl]     default www.sii.cl
 * @property {string} [plataforma]    plataforma emisora. Sin este campo —o con
 *                                    cualquier valor distinto de "ComunidadRural"— el
 *                                    membrete va SIN logo de plataforma
 * @property {string} [watermark]     SOLO demos: marca de agua diagonal
 * @property {string} [watermarkNote] nota al pie bajo el timbre (branding white-label)
 */

/**
 * Dibuja UNA muestra de factura sobre `page` (comparte doc + fuentes con el
 * caller → el PDF combinado del set reusa las mismas fuentes y queda liviano).
 * @returns {Promise<{xDimMils:number, cedible:boolean}>}
 */
async function drawFacturaOnPage({ doc, page, font, bold, logo, input }) {
  const tipo = Number(input.tipoDte);
  const meta = TIPO_DOC[tipo];
  if (!meta) throw new Error(`factura-pdf: tipoDte no soportado: ${input.tipoDte}`);

  // ¿Lleva ejemplar cedible? Solo F/F exenta/Guía/FC; NC/ND nunca. Guía: solo si
  // la operación constituye venta (traslado interno / no-venta → sin cedible).
  let cedibleType = meta.cedible;
  if (tipo === 52) {
    const tt = Number(input.despacho?.tipoTraslado);
    cedibleType = TRASLADO_VENTA.has(tt);
  }
  const cedible = Boolean(input.cedible) && cedibleType;

  const text = (s, x, y, size, f = font, color = C.ink) =>
    page.drawText(String(s), { x, y, size, font: f, color });
  const textR = (s, xR, y, size, f = font, color = C.ink) =>
    page.drawText(String(s), { x: xR - f.widthOfTextAtSize(String(s), size), y, size, font: f, color });
  const textC = (s, cx, y, size, f = font, color = C.ink) =>
    page.drawText(String(s), { x: cx - f.widthOfTextAtSize(String(s), size) / 2, y, size, font: f, color });
  const rect = (x, yTop, w, h, { fill, border, borderW = 0 } = {}) =>
    page.drawRectangle({ x, y: yTop - h, width: w, height: h, color: fill, borderColor: border, borderWidth: borderW });
  const hline = (x1, x2, yy, thickness = 0.5, color = C.hairline) =>
    page.drawLine({ start: { x: x1, y: yy }, end: { x: x2, y: yy }, thickness, color });

  // Marca de agua SOLO demos (al fondo; la quiet zone opaca del timbre la enmascara).
  if (input.watermark) {
    const wm = String(input.watermark).toUpperCase().slice(0, 14);
    const wmSize = wm.length <= 4 ? 110 : wm.length <= 8 ? 90 : 60;
    const wmW = bold.widthOfTextAtSize(wm, wmSize);
    page.drawText(wm, {
      x: PAGE_W / 2 - wmW * 0.44, y: PAGE_H / 2 - 30, size: wmSize, font: bold,
      color: C.red, rotate: degrees(-28), opacity: 0.06,
    });
  }

  let y = PAGE_H - MARGIN;

  // ── Recuadro de tipo de documento (arriba-derecha) — ROJO ─────────────────
  const rbW = 215;
  const rbX = RIGHT - rbW;
  const rbTop = y;
  const twoLines = meta.box.length > 1;
  const rbH = twoLines ? 84 : 74;
  rect(rbX, rbTop, rbW, rbH, { border: C.red, borderW: 1.6 });
  const rbCx = rbX + rbW / 2;
  textC(`R.U.T.: ${fmtRut(input.emisor.rut)}`, rbCx, rbTop - 20, 12.5, bold, C.red);
  let by = rbTop - 38;
  // Auto-ajuste por línea: los nombres de export ("EXPORTACIÓN ELECTRÓNICA") no caben a 12.5pt en el
  // recuadro de 215pt → se achican hasta entrar (piso 10pt, mínimo del manual §1.1.4 "alta y negritas").
  const rbInnerW = rbW - 16;
  for (const ln of meta.box) {
    let fs = 12.5;
    while (fs > 10 && bold.widthOfTextAtSize(ln, fs) > rbInnerW) fs -= 0.5;
    textC(ln, rbCx, by, fs, bold, C.red);
    by -= 15;
  }
  textC(`N° ${input.folio}`, rbCx, twoLines ? rbTop - 70 : rbTop - 58, 13, bold, C.red);
  // Unidad/Oficina del SII bajo el recuadro: override explícito > jurisdicción por comuna > comuna.
  // Sin dato resoluble (emisor sin comuna) la línea se omite COMPLETA: el manual pide
  // la Dirección Regional/Unidad, y un "S.I.I. —" colgando no es una unidad.
  const unidad = (input.siiUnidad || resolveSiiOficina(input.emisor.comuna) || input.emisor.comuna || "").toUpperCase();
  if (unidad) textC(`S.I.I. — ${unidad}`, rbCx, rbTop - rbH - 13, 9.5, bold, C.red);

  // ── Bloque emisor (arriba-izquierda): logo de marca + datos ───────────────
  // Sin logo (tenant white-label o PNG ausente) el bloque colapsa hacia arriba:
  // la razón social del emisor encabeza, no queda hueco.
  const emiMaxW = rbX - MARGIN - 16;
  let emiTop = y;
  if (logo && llevaLogoPlataforma(input)) {
    const lw = 122;
    const lh = (logo.height / logo.width) * lw;
    page.drawImage(logo, { x: MARGIN, y: y - lh, width: lw, height: lh });
    emiTop = y - lh - 4;
  }
  text(String(input.emisor.razonSocial || "").toUpperCase(), MARGIN, emiTop - 11, 12.5, bold, C.deepGreen);
  let ey = emiTop - 27;
  const emiLine = (label, value, opts = {}) => {
    if (!value) return;
    const lf = opts.bold ? bold : font;
    if (label) {
      text(`${label}: `, MARGIN, ey, 9, bold, C.gray);
      const lw = bold.widthOfTextAtSize(`${label}: `, 9);
      for (const ln of wrapText(value, font, 9, emiMaxW - lw)) {
        text(ln, MARGIN + lw, ey, 9, font, C.ink); ey -= 12;
      }
    } else {
      for (const ln of wrapText(value, lf, 9, emiMaxW)) { text(ln, MARGIN, ey, 9, lf, C.ink); ey -= 12; }
    }
  };
  emiLine("Giro", input.emisor.giro);
  const casaMatriz = [input.emisor.direccion, input.emisor.comuna].filter(Boolean).join(", ");
  emiLine("Casa Matriz", casaMatriz);
  emiLine("Sucursal", input.emisor.sucursal);
  const contacto = [
    input.emisor.telefono ? `Fono: ${input.emisor.telefono}` : "",
    input.emisor.email || "",
  ].filter(Boolean).join("  ·  ");
  emiLine("", contacto);
  // Contacto de atención que el emisor definió al emitir. En dos líneas: juntas
  // se pasan del ancho del bloque y el wrap deja el horario bajo el recuadro rojo.
  const rep = input.representacion || {};
  emiLine("Atención y emergencias", rep.contacto?.fono);
  emiLine("Horario de atención", rep.contacto?.horario);

  // Línea de fecha de emisión (con ciudad), a la derecha, bajo el recuadro.
  const ciudadEmi = input.emisor.ciudad || input.emisor.comuna || "";
  const fechaLinea = `${ciudadEmi ? ciudadEmi + ", " : ""}${fmtFechaLarga(input.fechaEmision)}`;
  const yFecha = Math.min(ey, rbTop - rbH - 24) - 4;
  textR(fechaLinea, RIGHT, yFecha, 10, bold, C.black);
  y = yFecha - 12;

  // ── Receptor (caja bordeada, 2 columnas) ──────────────────────────────────
  const rcp = input.receptor || {};
  const recH = 58;
  rect(MARGIN, y, CONTENT_W, recH, { fill: C.cardBg, border: C.cardBorder, borderW: 0.8 });
  const colA = MARGIN + 10;
  const colB = MARGIN + CONTENT_W * 0.62;
  const labW = 64;
  let ay = y - 15;
  const recField = (x, label, value) => {
    text(label, x, ay, 8.5, bold, C.gray);
    const lines = wrapText(value || "—", font, 9, (x === colA ? colB - colA - labW - 6 : RIGHT - x - labW - 10));
    text(lines[0] ?? "—", x + labW, ay, 9, font, C.ink);
  };
  // Fila 1
  recField(colA, "Señor(es):", rcp.razonSocial);
  recField(colB, "R.U.T.:", rcp.rut ? fmtRut(rcp.rut) : "");
  ay -= 15;
  // Fila 2
  recField(colA, "Giro:", rcp.giro);
  recField(colB, "Comuna:", rcp.comuna);
  ay -= 15;
  // Fila 3
  recField(colA, "Dirección:", rcp.direccion);
  recField(colB, "Ciudad:", rcp.ciudad || rcp.comuna);
  y = y - recH - 14;

  // ── Datos extra del emisor ────────────────────────────────────────────────
  // La factura no tiene la tarjeta "Datos del documento" que sí trae la boleta,
  // así que las filas van acá, entre el receptor y las referencias: siguen
  // identificando la operación, que es para lo que sirve el canal.
  const datosExtra = (Array.isArray(rep.datos) ? rep.datos : [])
    .filter((d) => d && d.label && d.valor != null && d.valor !== "");
  for (const d of datosExtra) {
    const label = `${String(d.label).slice(0, 46)}: `;
    text(label, MARGIN, y - 9, 8.5, bold, C.gray);
    text(String(d.valor).slice(0, 46), MARGIN + bold.widthOfTextAtSize(label, 8.5), y - 9, 8.5, font, C.ink);
    y -= 13;
  }
  if (datosExtra.length > 0) y -= 5;

  // ── Referencias (si corresponde) ──────────────────────────────────────────
  const refs = Array.isArray(input.referencias) ? input.referencias : [];
  if (refs.length > 0) {
    rect(MARGIN, y, CONTENT_W, 16, { fill: C.deepGreen });
    textC("Referencias a otros documentos", PAGE_W / 2, y - 11.5, 8.5, bold, C.white);
    y -= 16;
    const rc = { tipo: MARGIN + 8, folio: MARGIN + 225, fecha: MARGIN + 285, razon: MARGIN + 345 };
    text("Tipo Documento", rc.tipo, y - 11, 7.5, bold, C.gray);
    text("Folio", rc.folio, y - 11, 7.5, bold, C.gray);
    text("Fecha", rc.fecha, y - 11, 7.5, bold, C.gray);
    text("Razón Referencia", rc.razon, y - 11, 7.5, bold, C.gray);
    y -= 14;
    for (const r of refs) {
      const tipoPalabras = TIPO_DOC[Number(r.tipoDocRef)]?.words || String(r.tipoDocRef);
      text(tipoPalabras.slice(0, 40), rc.tipo, y - 9, 8, font, C.ink);
      text(String(r.folioRef ?? ""), rc.folio, y - 9, 8, font, C.ink);
      text(r.fchRef ? fmtFechaCorta(r.fchRef) : "", rc.fecha, y - 9, 8, font, C.ink);
      // Razón Referencia: ajustar al ancho de la columna (auto-achique hasta 6pt; … solo si aún no
      // entra) para que no se corte en el borde — razones largas (export NC/ND) caben prolijas.
      const razonW = RIGHT - rc.razon - 4;
      let rz = String(r.razonRef ?? ""), rzFs = 8;
      while (rzFs > 6 && font.widthOfTextAtSize(rz, rzFs) > razonW) rzFs -= 0.5;
      if (font.widthOfTextAtSize(rz, rzFs) > razonW) {
        while (rz.length > 1 && font.widthOfTextAtSize(rz + "…", rzFs) > razonW) rz = rz.slice(0, -1);
        rz += "…";
      }
      text(rz, rc.razon, y - 9, rzFs, font, C.ink);
      y -= 13;
    }
    rect(MARGIN, y + (refs.length * 13) + 14, CONTENT_W, 16 + refs.length * 13, { border: C.hairline, borderW: 0.6 });
    y -= 8;
  }

  // ── Guía: tipo de traslado ────────────────────────────────────────────────
  if (tipo === 52 && input.despacho?.tipoTraslado) {
    const tt = Number(input.despacho.tipoTraslado);
    text("Tipo de traslado: ", MARGIN, y - 9, 8.5, bold, C.gray);
    text(`${tt} — ${TRASLADO_LABEL[tt] || ""}`, MARGIN + bold.widthOfTextAtSize("Tipo de traslado: ", 8.5), y - 9, 8.5, font, C.ink);
    y -= 18;
  }

  // ── Tabla de detalle (columnas por right-edge para que no se solapen) ──────
  const dc = {
    item: MARGIN + 6,   // 46  (left)
    cod: MARGIN + 30,   // 70  (left)
    desc: MARGIN + 88,  // 128 (left)
    cantR: MARGIN + 320, // 360 (right edge Cant.)
    un: MARGIN + 332,   // 372 (left Un.)
    puR: MARGIN + 418,  // 458 (right edge P. Unit.)
    dscR: MARGIN + 472, // 512 (right edge Dscto.)
    valR: RIGHT - 6,    // 566 (right edge Valor)
  };
  const descW = dc.cantR - 46 - dc.desc; // descripción no invade la columna Cant.
  rect(MARGIN, y, CONTENT_W, 16, { fill: C.deepGreen });
  const hy = y - 11.5;
  text("Item", dc.item, hy, 7.5, bold, C.white);
  text("Código", dc.cod, hy, 7.5, bold, C.white);
  text("Descripción", dc.desc, hy, 7.5, bold, C.white);
  textR("Cant.", dc.cantR, hy, 7.5, bold, C.white);
  text("Un.", dc.un, hy, 7.5, bold, C.white);
  textR("P. Unit.", dc.puR, hy, 7.5, bold, C.white);
  textR("Dscto.", dc.dscR, hy, 7.5, bold, C.white);
  textR("Valor", dc.valR, hy, 7.5, bold, C.white);
  y -= 16;
  const tableTop = y;
  let idx = 0;
  for (const it of input.items || []) {
    idx++;
    const gross = Math.round(Number(it.cantidad) * Number(it.precio));
    const dsc = it.descuentoMonto != null
      ? Math.round(Number(it.descuentoMonto))
      : (it.descuentoPct ? Math.round(gross * Number(it.descuentoPct) / 100) : 0);
    const valor = it.valor != null ? Math.round(Number(it.valor)) : gross - dsc;
    const descLines = wrapText(it.nombre ?? "", font, 8.5, descW);
    text(String(idx), dc.item, y - 9, 8.5, font, C.ink);
    text(String(it.codigo ?? "").slice(0, 9), dc.cod, y - 9, 8, font, C.ink);
    text(descLines[0] ?? "", dc.desc, y - 9, 8.5, font, C.ink);
    // "(EXENTO)" va DEBAJO de todas las líneas de la descripción (si la desc baja a 2+ líneas, no se
    // pisa con la última línea). descLines.length=1 → y-18 (igual que antes); =2 → y-27; etc.
    if (it.exento) text("(EXENTO)", dc.desc, y - 9 - descLines.length * 9, 6.5, font, C.gray);
    textR(fmtNum(it.cantidad), dc.cantR, y - 9, 8.5, font, C.ink);
    text(String(it.unidad ?? "").slice(0, 6), dc.un, y - 9, 8, font, C.ink);
    textR(Number(it.precio) ? fmtNum(it.precio) : "—", dc.puR, y - 9, 8.5, font, C.ink);
    textR(dsc > 0 ? fmtNum(dsc) : "—", dc.dscR, y - 9, 8.5, font, dsc > 0 ? C.ink : C.grayLabel);
    textR(fmtNum(valor), dc.valR, y - 9, 8.5, font, C.ink);
    const rowH = (it.exento ? 22 : 16) + Math.max(0, descLines.length - 1) * 9;
    // descripciones largas en líneas extra
    for (let i = 1; i < descLines.length; i++) text(descLines[i], dc.desc, y - 9 - i * 9, 8.5, font, C.ink);
    y -= rowH;
    hline(MARGIN, RIGHT, y + 3, 0.4);
  }
  rect(MARGIN, tableTop, CONTENT_W, tableTop - y, { border: C.hairline, borderW: 0.6 });
  y -= 12;

  // ── Totales (caja a la derecha) ───────────────────────────────────────────
  const t = input.totales || {};
  // Exportación: montos en moneda extranjera (TpoMoneda, hasta 4 decimales), sin IVA; equivalente CLP opcional.
  const isExport = !!t.tpoMoneda;
  const fmtMon = (v) => Number(v || 0).toLocaleString("es-CL", { maximumFractionDigits: 4 }) + " " + t.tpoMoneda;
  const fmtTot = isExport ? fmtMon : fmtCLP;
  const isExentaOnly = (Number(t.neto) || 0) === 0 && (Number(t.exento) || 0) > 0;
  const rows = [];
  const row = (label, val, opts = {}) => rows.push({ label, val, ...opts });

  // ── Escaleras del emisor ──────────────────────────────────────────────────
  // Van ARRIBA de los montos del documento, igual que en la boleta: son los
  // conceptos que componen lo cobrado, y el total del DTE los cierra. El render
  // no sabe qué significan — dibuja etiqueta + valor ya formateado. Quién decide
  // qué conceptos aparecen (y cuáles se omiten por ir en cero) es el emisor, que
  // es el que conoce su normativa.
  const bloques = (Array.isArray(rep.bloques) ? rep.bloques : []).filter(
    (b) => b && Array.isArray(b.filas) && b.filas.length > 0,
  );
  for (const b of bloques) {
    if (b.titulo) row(String(b.titulo).slice(0, 46), "", { titulo: true });
    for (const fila of b.filas) {
      if (!fila || !fila.label) continue;
      // `valor` es opcional: una fila puede ser solo una leyenda ("Convenio de
      // pago · cuota 10/15"), sin monto propio.
      row(String(fila.label).slice(0, 46), fila.valor ?? "", {
        enfasis: !!fila.enfasis,
        sub: fila.sub,
      });
    }
  }

  if (Number(t.descuentoGlobal) > 0) row("Descuento", fmtTot(t.descuentoGlobal));
  if (isExport) {
    row("Monto Exento", fmtMon(t.exento));
    if (Number(t.otraMoneda) > 0) row("Equivalente CLP", fmtCLP(t.otraMoneda));
  } else if (isExentaOnly) {
    row("Monto Exento", fmtCLP(t.exento));
  } else {
    if (Number(t.neto) > 0) row("Monto Neto", fmtCLP(t.neto));
    if (Number(t.exento) > 0) row("Monto Exento", fmtCLP(t.exento));
    if (Number(t.neto) > 0) row(`I.V.A. (${t.tasaIva ?? 19}%)`, fmtCLP(t.iva));
  }
  // Liquidación-Factura (43): Comisiones y Otros Cargos del mandatario — se RESTAN del Monto Total
  // (Neto + Exento + IVA − Comisiones = Total). Los valores pueden ser negativos (ajustes).
  const com = (Number(t.valComNeto) || 0) + (Number(t.valComExe) || 0) + (Number(t.valComIVA) || 0);
  if (com !== 0) row("Comisiones y Otros Cargos", fmtTot(-com));
  // Con escaleras del emisor la caja se ensancha: los conceptos suelen ser largos
  // ("Fondo de reposición y reinversión") y en 215pt se pisan con el monto.
  const totW = bloques.length > 0 ? 290 : 215;
  const totX = RIGHT - totW;
  const rowH = 16;
  let ty = y;
  for (const r of rows) {
    const h = r.sub ? rowH + 9 : rowH;
    rect(totX, ty, totW, h, { border: C.hairline, borderW: 0.5 });
    const f = r.enfasis || r.titulo ? bold : font;
    const color = r.titulo ? C.deepGreen : C.ink;
    const val = r.val == null ? "" : String(r.val);
    // La etiqueta se achica hasta que entra junto al monto: una fila del emisor
    // puede ser más larga que "Monto Neto" y cortarla sería mutilar el dato.
    const dispW = totW - 16 - (val ? f.widthOfTextAtSize(val, 9) + 8 : 0);
    let label = String(r.label), fs = 9;
    while (fs > 6.5 && f.widthOfTextAtSize(label, fs) > dispW) fs -= 0.5;
    if (f.widthOfTextAtSize(label, fs) > dispW) {
      while (label.length > 1 && f.widthOfTextAtSize(label + "…", fs) > dispW) label = label.slice(0, -1);
      label += "…";
    }
    text(label, totX + 8, ty - 11, fs, f, color);
    if (val) textR(val, RIGHT - 8, ty - 11, 9, f, C.ink);
    if (r.sub) text(String(r.sub).slice(0, 60), totX + 12, ty - 20, 6.5, font, C.grayLabel);
    ty -= h;
  }
  rect(totX, ty, totW, rowH, { fill: C.deepGreen, border: C.deepGreen, borderW: 0.8 });
  text("Monto Total", totX + 8, ty - 11.5, 9.5, bold, C.white);
  textR(fmtTot(t.total), RIGHT - 8, ty - 11.5, 10.5, bold, C.white);
  let belowTot = ty - rowH - 14;

  // ── Leyenda y notas del emisor ────────────────────────────────────────────
  // Van a la IZQUIERDA, en la banda que la caja de totales deja libre, y NO
  // suman al total: informan (p.ej. un acuse de pagos recibidos, que no cobra).
  //
  // `leyendaVencimiento` en la boleta REEMPLAZA la fecha de su franja; la factura
  // no tiene esa franja, así que acá se dibuja como línea propia y destacada. Se
  // dibuja igual porque descartar en silencio lo que el emisor mandó es peor que
  // ubicarlo distinto.
  if (rep.leyendaVencimiento) {
    text(String(rep.leyendaVencimiento).slice(0, 32), MARGIN, belowTot, 10, bold, C.red);
    belowTot -= 13;
  }
  for (const nota of Array.isArray(rep.notas) ? rep.notas : []) {
    if (!nota) continue;
    text(String(nota).slice(0, 118), MARGIN, belowTot, 8, font, C.grayLabel);
    belowTot -= 10;
  }
  const afterTotalsY = Math.min(ty - rowH - 16, belowTot - 2);

  // ── Zona inferior: timbre (izq) + acuse/CEDIBLE (der) ─────────────────────
  // El timbre se ancla cerca del pie; el acuse comparte su fila a la derecha.
  const bc = await buildTedPdf417Png(input.tedXml);
  let sc = Math.min(
    TARGET_XDIM_MILS / MILS_PER_PT,
    TIMBRE_MAX_H_PT / bc.height,
    TIMBRE_MAX_W_PT / bc.width,
  );
  // Respetar el ancho/alto mínimos del SII (2×5 cm) sin exceder los máximos.
  sc = Math.max(sc, TIMBRE_MIN_W_PT / bc.width, TIMBRE_MIN_H_PT / bc.height);
  sc = Math.min(sc, TIMBRE_MAX_W_PT / bc.width, TIMBRE_MAX_H_PT / bc.height);
  const drawW = bc.width * sc;
  const drawH = bc.height * sc;
  const xDimMils = sc * MILS_PER_PT;

  const QZ = 12; // quiet zone opaca (regla SII ≥0,25"): aísla el código del resto
  // Borde izquierdo del símbolo ≥ 2 cm del borde de la página.
  const tbX = Math.max(MARGIN + QZ, TIMBRE_MIN_LEFT_PT);
  const capH = 22; // alto reservado para el caption bajo el timbre
  // Anclar la fila del timbre cerca del pie de página (deja respiro inferior).
  const rowBottom = MARGIN + 14;
  const tbTop = Math.min(afterTotalsY, rowBottom + capH + drawH + QZ);

  page.drawRectangle({
    x: tbX - QZ, y: tbTop - drawH - QZ, width: drawW + 2 * QZ, height: drawH + 2 * QZ, color: C.white,
  });
  // Timbre como imagen RASTER (PNG 1px/módulo) escalada por vecino-más-cercano
  // (Interpolate=false de pdf-lib) → módulos nítidos que decodifican a cualquier
  // resolución; el SII lo recomienda y evita el aliasing del trazo vectorial.
  const timbreImg = await doc.embedPng(bc.png);
  page.drawImage(timbreImg, { x: tbX, y: tbTop - drawH, width: drawW, height: drawH });
  // Caption SII bajo el timbre (centrado respecto al símbolo).
  const symCx = tbX + drawW / 2;
  let capY = tbTop - drawH - QZ - 8;
  textC("Timbre Electrónico SII", symCx, capY, 7.5, bold, C.gray);
  capY -= 10;
  const resN = input.resolucion?.numero ?? 0;
  const resA = input.resolucion?.anio ?? yearOf(input.fechaEmision);
  const verify = input.verifyUrl || DEFAULT_VERIFY;
  textC(`Res. ${resN} de ${resA} - Verifique documento: ${verify}`, symCx, capY, 7, font, C.gray);
  // Nota al pie opcional (branding white-label, p.ej. plan gratis de RuralDTE):
  // misma tipografía del caption, bajo la línea de la resolución.
  if (input.watermarkNote) {
    capY -= 10;
    textC(String(input.watermarkNote).slice(0, 110), symCx, capY, 7, font, C.gray);
  }

  // ── Acuse de Recibo (Ley 19.983) + CEDIBLE — SOLO ejemplar cedible ────────
  if (cedible) {
    const acX = tbX + drawW + QZ + 14;
    const acW = RIGHT - acX;
    const acTop = tbTop;
    // Alto fijo que garantiza que quepa el texto legal completo (Res. 51/2005),
    // sin bajar del margen inferior (independiente del alto del timbre).
    const acH = Math.min(106, acTop - (MARGIN + 4));
    rect(acX, acTop, acW, acH, { border: C.line, borderW: 0.8 });
    let qy = acTop - 14;
    text("Acuse de Recibo", acX + 8, qy, 8.5, bold, C.black);
    qy -= 16;
    const fld = (label, x, w) => {
      text(label, x, qy, 8, font, C.ink);
      const lx = x + font.widthOfTextAtSize(label, 8) + 3;
      hline(lx, x + w, qy - 1, 0.5, C.line);
    };
    const halfW = (acW - 24) / 2;
    fld("Nombre:", acX + 8, acW - 16); qy -= 15;
    fld("R.U.T.:", acX + 8, halfW); fld("Fecha:", acX + 8 + (acW - 8) / 2, halfW); qy -= 15;
    fld("Recinto:", acX + 8, halfW); fld("Firma:", acX + 8 + (acW - 8) / 2, halfW); qy -= 13;
    const legal =
      "El acuse de recibo que se declara en este acto, de acuerdo a lo dispuesto en la letra b) del Art. 4°, " +
      "y la letra c) del Art. 5° de la Ley 19.983, acredita que la entrega de mercaderías o servicio(s) " +
      "prestado(s) ha(n) sido recibido(s).";
    for (const ln of wrapText(legal, font, 5.5, acW - 16)) {
      text(ln, acX + 8, qy, 5.5, font, C.gray); qy -= 7;
    }
    // Leyenda de destino (zona inferior derecha). Guía: "CEDIBLE CON SU FACTURA".
    const leyenda = tipo === 52 ? "CEDIBLE CON SU FACTURA" : "CEDIBLE";
    textR(leyenda, RIGHT, acTop - acH - 12, 11, bold, C.black);
  }

  return { xDimMils, cedible };
}

/** Embebe el logo wordmark una vez por documento (se reusa en todas las páginas). */
async function embedLogo(doc) {
  if (!LOGO_WORDMARK_BYTES) return null;
  try {
    return await doc.embedPng(LOGO_WORDMARK_BYTES);
  } catch {
    return null;
  }
}

/** @param {FacturaPdfInput} input @returns {Promise<{pdf:Uint8Array, xDimMils:number, cedible:boolean}>} */
export async function generateFacturaPdf(input) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  // No embeber el logo si no se va a dibujar (que el PDF del tenant ni siquiera
  // lleve los bytes de la marca CR adentro).
  const logo = llevaLogoPlataforma(input) ? await embedLogo(doc) : null;
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const { xDimMils, cedible } = await drawFacturaOnPage({ doc, page, font, bold, logo, input });
  return { pdf: await doc.save(), xDimMils, cedible };
}

/**
 * Genera UN PDF combinado con una página por documento — el formato que pide el
 * SII para la etapa 4 de la cert: "un archivo PDF adjunto a un correo electrónico
 * enviado a sii_dte_impresos@sii.cl que contenga la imagen de todos los
 * documentos del set" (manual_certificacion.pdf §4). Comparte fuentes entre
 * páginas (PDF más liviano que 1 archivo por doc).
 * @param {FacturaPdfInput[]} docs
 * @returns {Promise<{pdf:Uint8Array, pages:{tipoDte:number, folio:number, cedible:boolean, xDimMils:number}[]}>}
 */
export async function generateFacturaSetPdf(docs) {
  if (!Array.isArray(docs) || docs.length === 0) throw new Error("generateFacturaSetPdf: docs vacío");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  // Embeber solo si alguna página lo dibuja (sets mixtos CR + tenant).
  const logo = docs.some((d) => llevaLogoPlataforma(d)) ? await embedLogo(doc) : null;
  const pages = [];
  for (const input of docs) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    const { xDimMils, cedible } = await drawFacturaOnPage({ doc, page, font, bold, logo, input });
    pages.push({ tipoDte: Number(input.tipoDte), folio: Number(input.folio), cedible, xDimMils });
  }
  return { pdf: await doc.save(), pages };
}
