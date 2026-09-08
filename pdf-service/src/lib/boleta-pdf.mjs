// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// boleta-pdf.mjs — Generador PURO de la representación impresa de la Boleta
// Electrónica (Componente E). Sin IO/Supabase (testeable aislado); el handler
// HTTP con upload a Storage vive en handlers/boleta.mjs.
//
// Look&feel: marca Comunidad Rural (verde) sobre el formato del SII
// (ejemplos_representacion_be + Instructivo A.2.5):
//   – Recuadro ROJO redondeado (obligatorio): R.U.T. + "BOLETA ELECTRÓNICA
//     [EXENTA]" + N° folio + "S.I.I. — <comuna> · DTE NN".
//   – Tarjetas Receptor (socio) + Datos de la boleta.
//   – Tabla de lectura de medidor (opcional, agua) + tabla de detalle.
//   – Totales (Monto exento/Neto + IVA + TOTAL A PAGAR).
//   – Timbre PDF417 (Byte Compaction, ECL 5) + caption SII.
//   – Franja de vencimiento (opcional) + nota legal Ley 20.998.
//
// Es el documento TRIBUTARIO del APR (emisor = el APR). La firma/timbre ya
// vienen calculados (tedXml). Montos en pesos enteros (convención del proyecto).
// ============================================================================

import { degrees, PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { buildTedPdf417, TIMBRE_MAX_H_PT, TIMBRE_MAX_W_PT } from "./pdf417.mjs";
import { resolveSiiOficina } from "./sii-oficinas.mjs";

const MILS_PER_PT = 1000 / 72; // 1 pt = 1000/72 mils
const TARGET_XDIM_MILS = 7.5; // holgura sobre el mínimo SII (6.7)

const PAGE_W = 612; // LETTER
const PAGE_H = 792;
const MARGIN = 40;
const RIGHT = PAGE_W - MARGIN;
const CONTENT_W = PAGE_W - 2 * MARGIN;
// Mismo default que factura-pdf.mjs. Antes era el sitio de Comunidad Rural: en
// el documento de UN TERCERO no corresponde imprimir nuestra marca. Se verificó
// que NADIE dependía de él —los tres llamadores de /pdf/boleta (agent-boleta-pdf
// y dte-demo-boleta en CR, y el gateway de RuralDTE) pasan `verifyUrl` explícito—,
// así que cambiarlo no altera ningún documento que se emita hoy.
const DEFAULT_VERIFY_URL = "www.sii.cl";

const C = {
  black: rgb(0, 0, 0),
  white: rgb(1, 1, 1),
  brandGreen: rgb(0.0824, 0.502, 0.2392), // #15803d
  deepGreen: rgb(0.0196, 0.1804, 0.0863), // #052e16 (barras de encabezado)
  cardBg: rgb(0.957, 0.976, 0.965), // #f4f9f6
  cardBorder: rgb(0.843, 0.902, 0.867), // #d7e6dd
  red: rgb(0.737, 0.231, 0.169), // #bc3b2b (recuadro SII)
  gray: rgb(0.34, 0.34, 0.34),
  grayLabel: rgb(0.46, 0.46, 0.46),
  line: rgb(0.87, 0.87, 0.87),
};

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

const fmtCLP = (v) => "$ " + Math.round(Number(v) || 0).toLocaleString("es-CL");
const fmtNum = (v) => Math.round(Number(v) || 0).toLocaleString("es-CL");
/**
 * Cantidades que NO son plata (m³ leídos, m³ facturados): hasta 2 decimales y
 * sin ceros de relleno. Redondear a entero imprimía "10 m³" en la tabla de
 * lectura mientras el cargo variable cobraba 10,11 — el socio compara las dos
 * cifras y el reclamo por esa diferencia es correcto. Los m³ vienen partidos en
 * centésimas desde que el consumo acumulado se prorratea por días.
 */
const fmtCant = (v) => (Number(v) || 0).toLocaleString("es-CL", { maximumFractionDigits: 2 });

/** "78416626-0" → "78.416.626-0". */
function fmtRut(rut) {
  if (!rut) return "";
  const m = String(rut).replace(/\./g, "").trim().match(/^(\d+)-?([0-9kK])$/);
  if (!m) return String(rut);
  return Number(m[1]).toLocaleString("es-CL") + "-" + m[2].toUpperCase();
}

/** "2026-06-10" → "10/06/2026". */
function fmtFechaCorta(iso) {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso ?? "");
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function tituloBoleta(tipoDte) {
  return tipoDte === 41 ? ["BOLETA ELECTRÓNICA", "EXENTA"] : ["BOLETA ELECTRÓNICA"];
}

/** Path SVG de un rectángulo redondeado (origen top-left, y hacia abajo). */
function roundRectPath(w, h, r) {
  return `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} ` +
    `A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} ` +
    `V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
}

/**
 * Contenido extra de la representación impresa, NEUTRO al rubro del emisor.
 *
 * Todos los valores llegan YA FORMATEADOS (strings): el emisor sabe si cobra en
 * pesos, UF o dólares y con qué signo — el render no decide eso. Esta es la
 * costura que permite que la misma boleta sirva a un servicio sanitario, un
 * gimnasio o un colegio sin que el generador aprenda sus reglas.
 *
 * @typedef {object} Representacion
 * @property {{label:string, valor:string}[]} [datos]
 *   Filas extra en la tarjeta "Datos de la boleta" (p.ej. "N° de servicio").
 * @property {{titulo?:string, filas:{label:string, valor?:string, sub?:string, enfasis?:boolean}[]}[]} [bloques]
 *   Escaleras de conceptos sobre el total. `enfasis` marca la fila como corte
 *   (regla + negrita, p.ej. un SUBTOTAL); `sub` es una línea chica de detalle
 *   bajo la fila; `valor` es opcional (una fila puede ser solo una leyenda).
 * @property {string} [leyendaVencimiento]
 *   REEMPLAZA la fecha en la franja de vencimiento (p.ej. "Corte en trámite").
 * @property {{fono?:string, horario?:string}} [contacto]
 *   Teléfono de atención y su horario, bajo los datos del emisor.
 * @property {string[]} [notas]
 *   Líneas informativas al pie de los totales que NO suman al total
 *   (p.ej. pagos recibidos desde la última facturación).
 */

/**
 * @typedef {object} BoletaPdfInput
 * @property {39|41} tipoDte
 * @property {number} folio
 * @property {string} fechaEmision         ISO "AAAA-MM-DD"
 * @property {{rut:string, razonSocial:string, giro?:string, direccion?:string, comuna?:string, region?:string, email?:string}} emisor
 * @property {string} [siiSucursal]        unidad SII; default emisor.comuna
 * @property {{rut?:string, nombre?:string, direccion?:string, esSocio?:boolean}} [receptor]
 *   `esSocio` decide el rótulo de la tarjeta: true → "RECEPTOR (SOCIO)",
 *   false → "RECEPTOR (NO SOCIO)". Sin el dato el rótulo queda neutro
 *   ("RECEPTOR"): NO se infiere del tipoDte — la boleta de LUZ de un socio
 *   también es 39, así que inferir ahí etiquetaría mal a un socio.
 * @property {{nombre:string, cantidad:number, precio:number, valor?:number}[]} items
 * @property {{neto?:number, iva?:number, exento?:number, total:number}} totales
 * @property {string} tedXml               <TED>…</TED> para el PDF417
 * @property {string} [verifyUrl]          default www.sii.cl
 * @property {string} [plataforma]         nombre en la línea legal "declarado al SII a
 *                                         través de …". SIN default: si no lo pasas, esa
 *                                         cláusula no se imprime.
 * @property {string} [periodo]            "Mayo 2026" (Datos de la boleta)
 * @property {string} [medidor]            "A-042"
 * @property {string} [medidorLabel]       rótulo de esa fila; default "Medidor N°"
 * @property {{anterior:number, actual:number, consumo:number, tarifa:number, unidad?:string,
 *   fechaAnterior?:string, fechaActual?:string, unidadesAbonar?:number,
 *   etiquetas?:string[]}} [lectura]
 *   Tabla de medidor. `fechaAnterior`/`fechaActual` son la fecha en que se tomó
 *   cada lectura; `unidadesAbonar` son las unidades a abonar (+) o restar (−) en
 *   futuras facturaciones cuando el período se facturó sin lectura.
 *
 *   `unidad` y `etiquetas` son lo que hace que esta tabla NO sea sanitaria: la
 *   unidad ya era del emisor (default "m³") y los cuatro encabezados también lo
 *   son ahora (default "Lectura anterior" / "Lectura actual" / "Consumo del
 *   período" / "Tarifa vigente"). Un gimnasio manda `unidad:"horas"` +
 *   `etiquetas:["Horas del mes anterior", …]` y usa la misma franja. Sin este
 *   override, el único escape era dejar de mandar `lectura` y degradar la tabla
 *   de 4 columnas a filas de `representacion` — perder el diseño para esquivar
 *   un rótulo.
 * @property {Representacion} [representacion]
 *   Contenido EXTRA de la representación impresa, agnóstico al rubro. No toca el
 *   XML del SII ni los totales tributarios: es lo que el emisor necesita decirle
 *   a SU cliente. Un servicio sanitario arma acá el Capítulo 2 del Manual SISS
 *   (subsidio, convenio, corte en trámite); un gimnasio armaría "clases
 *   restantes"; un colegio, "beca 30%". El render NO conoce ninguno de esos
 *   dominios — solo dibuja lo que le pasan, ya formateado.
 * @property {string} [vencimiento]        ISO; activa la franja de vencimiento
 * @property {string} [notaPago]           texto de la franja
 * @property {string} [resolucion]         "Res. 80 del 2014"
 * @property {string} [watermark]          SOLO demos (p.ej. "DEMO"): marca de agua diagonal. Oficiales sin marca.
 * @property {string} [watermarkNote]      nota al pie: acompaña al watermark (default demo)
 *                                         o va SOLA sin diagonal (branding white-label,
 *                                         p.ej. el plan gratis de RuralDTE)
 */

/** @param {BoletaPdfInput} input @returns {Promise<{pdf:Uint8Array, xDimMils:number}>} */
export async function generateBoletaElectronicaPdf(input) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const tipoDte = input.tipoDte === 41 ? 41 : 39;

  // Marca de agua SOLO para demos (input.watermark, p.ej. "DEMO"). Los documentos
  // OFICIALES no llevan marca. Se dibuja al FONDO (antes de todo) → la quiet zone
  // opaca del timbre la enmascara y no interfiere con el decode del PDF417.
  if (input.watermark) {
    const wm = String(input.watermark).toUpperCase().slice(0, 14);
    const wmSize = wm.length <= 4 ? 110 : wm.length <= 8 ? 90 : 60;
    const wmW = bold.widthOfTextAtSize(wm, wmSize);
    page.drawText(wm, {
      x: PAGE_W / 2 - wmW * 0.44, y: PAGE_H / 2 - 30, size: wmSize, font: bold,
      color: C.brandGreen, rotate: degrees(-28), opacity: 0.07,
    });
  }

  const text = (s, x, y, size, f = font, color = C.black) =>
    page.drawText(String(s), { x, y, size, font: f, color });
  const textR = (s, xR, y, size, f = font, color = C.black) =>
    page.drawText(String(s), { x: xR - f.widthOfTextAtSize(String(s), size), y, size, font: f, color });
  const textC = (s, cx, y, size, f = font, color = C.black) =>
    page.drawText(String(s), { x: cx - f.widthOfTextAtSize(String(s), size) / 2, y, size, font: f, color });
  const roundRect = (x, yTop, w, h, r, { fill, border, borderW = 0 } = {}) =>
    page.drawSvgPath(roundRectPath(w, h, r), {
      x, y: yTop, color: fill, borderColor: border, borderWidth: borderW,
    });

  let y = PAGE_H - MARGIN;

  // ── Recuadro ROJO (derecha) ──────────────────────────────────────────────
  const rbW = 210;
  const rbX = RIGHT - rbW;
  const rbTop = y + 6;
  const rbH = 92;
  roundRect(rbX, rbTop, rbW, rbH, 8, { border: C.red, borderW: 1.5 });
  const rbCx = rbX + rbW / 2;
  textC(`R.U.T. ${fmtRut(input.emisor.rut)}`, rbCx, rbTop - 22, 12.5, bold, C.red);
  const titulo = tituloBoleta(tipoDte);
  textC(titulo[0], rbCx, rbTop - 39, 11, bold, C.red);
  if (titulo[1]) textC(titulo[1], rbCx, rbTop - 51, 11, bold, C.red);
  textC(`N° ${input.folio}`, rbCx, rbTop - (titulo[1] ? 70 : 64), 16, bold, C.red);
  page.drawLine({
    start: { x: rbX + 12, y: rbTop - rbH + 20 }, end: { x: rbX + rbW - 12, y: rbTop - rbH + 20 },
    thickness: 0.6, color: C.red,
  });
  // Unidad SII = OFICINA con jurisdicción sobre la comuna (NO la comuna).
  // resolveSiiOficina mapea comuna→oficina ("Quinta Normal" → "Santiago Poniente").
  // siiSucursal puede llegar como comuna cruda (callers legacy) → también se mapea;
  // si ya es una oficina o no se reconoce, se usa tal cual (fallback con gracia).
  const sii = (
    resolveSiiOficina(input.siiSucursal) || input.siiSucursal ||
    resolveSiiOficina(input.emisor.comuna) || input.emisor.comuna || ""
  ).toUpperCase();
  // Sin unidad resoluble se omite el "S.I.I. —" (nada de prefijo colgando); el
  // "DTE NN" se conserva siempre.
  textC(sii ? `S.I.I. — ${sii} · DTE ${tipoDte}` : `DTE ${tipoDte}`, rbCx, rbTop - rbH + 8, 8, bold, C.red);

  // ── Bloque emisor (izquierda) ────────────────────────────────────────────
  text(input.emisor.razonSocial || "", MARGIN, y - 8, 15, bold, C.deepGreen);
  let ey = y - 26;
  // "Giro: <valor>" con label en bold y valor normal. El valor se ENVUELVE para
  // no invadir el recuadro rojo del SII (a la derecha): se acota a emisorMaxX.
  const emisorMaxX = rbX - 14;
  const wrapToWidth = (s, f, size, maxW) => {
    const out = [];
    let line = "";
    for (const w of String(s).split(/\s+/)) {
      const trial = line ? `${line} ${w}` : w;
      if (line && f.widthOfTextAtSize(trial, size) > maxW) { out.push(line); line = w; }
      else line = trial;
    }
    if (line) out.push(line);
    return out;
  };
  const labeled = (label, value) => {
    if (!value) return;
    const lab = `${label}: `;
    const labW = bold.widthOfTextAtSize(lab, 9.5);
    text(lab, MARGIN, ey, 9.5, bold, C.gray);
    const lines = wrapToWidth(value, font, 9.5, emisorMaxX - MARGIN - labW);
    text(lines[0] ?? "", MARGIN + labW, ey, 9.5, font, C.gray);
    ey -= 15;
    for (let i = 1; i < lines.length; i++) {
      text(lines[i], MARGIN + labW, ey, 9.5, font, C.gray);
      ey -= 15;
    }
  };
  labeled("Giro", input.emisor.giro);
  labeled("Dirección", input.emisor.direccion);
  const reg = [input.emisor.region, input.emisor.email].filter(Boolean).join(" · ");
  if (reg) { text(reg, MARGIN, ey, 9.5, font, C.gray); ey -= 15; }
  // §2.i — teléfono de atención de consultas y emergencias + horario de atención.
  // El dato existe hace rato en community_billing_settings y el chequeo 14 del
  // validador lo exige; hasta ahora no se imprimía.
  // Contacto de atención. En dos líneas: juntas se pasan del ancho disponible y
  // el wrap deja el horario colgando bajo el recuadro rojo.
  const rep = input.representacion || {};
  labeled("Atención y emergencias", rep.contacto?.fono);
  labeled("Horario de atención", rep.contacto?.horario);

  y = Math.min(ey, rbTop - rbH) - 14;

  // ── Tarjetas Receptor + Datos ────────────────────────────────────────────
  const gap = 16;
  const cardW = (CONTENT_W - gap) / 2;
  const cardTop = y;
  // La tarjeta se dimensiona según cuántas filas hay: el emisor puede sumar las
  // suyas por `representacion.datos` y antes 76pt fijos alcanzaban justo para 3.
  const datos = [
    ["Fecha emisión", fmtFechaCorta(input.fechaEmision)],
    ["Período facturado", input.periodo],
    // Mismo criterio que los encabezados de la lectura: el rótulo es del emisor
    // y "Medidor N°" es solo el default. Era la otra pieza de vocabulario de
    // rubro que quedaba fija, y estaba FUERA de `lectura` — o sea que dejar de
    // mandar la tabla no la sacaba.
    [input.medidorLabel || "Medidor N°", input.medidor],
    ...(Array.isArray(rep.datos) ? rep.datos : [])
      .filter((d) => d && d.label)
      .map((d) => [String(d.label), d.valor]),
  ].filter(([, v]) => v != null && v !== "");
  const cardH = Math.max(76, 34 + Math.max(0, datos.length - 1) * 14 + 12);
  for (const cx of [MARGIN, MARGIN + cardW + gap]) {
    roundRect(cx, cardTop, cardW, cardH, 6, { fill: C.cardBg, border: C.cardBorder, borderW: 0.8 });
  }
  // Receptor. El rótulo ya no afirma "SOCIO" a ciegas: sin `esSocio` queda neutro
  // (la boleta 39 puede ser de un NO socio o la de luz de un socio — no se infiere).
  const rcp = input.receptor || {};
  let cy = cardTop - 18;
  text(
    rcp.esSocio === true ? "RECEPTOR (SOCIO)" : rcp.esSocio === false ? "RECEPTOR (NO SOCIO)" : "RECEPTOR",
    MARGIN + 12, cy, 7.5, bold, C.brandGreen,
  );
  cy -= 16;
  text(rcp.nombre || "—", MARGIN + 12, cy, 11, bold, C.deepGreen);
  cy -= 14;
  text(`RUT ${rcp.rut ? fmtRut(rcp.rut) : "—"}`, MARGIN + 12, cy, 9, font, C.gray);
  cy -= 13;
  if (rcp.direccion) text(String(rcp.direccion).slice(0, 48), MARGIN + 12, cy, 9, font, C.gray);
  // Datos de la boleta
  const dX = MARGIN + cardW + gap + 12;
  let dy = cardTop - 18;
  text("DATOS DE LA BOLETA", dX, dy, 7.5, bold, C.brandGreen);
  dy -= 16;
  for (const [label, value] of datos) {
    text(`${label}: `, dX, dy, 9, bold, C.gray);
    text(String(value), dX + bold.widthOfTextAtSize(`${label}: `, 9), dy, 9, font, C.black);
    dy -= 14;
  }

  y = cardTop - cardH - 16;

  // ── Tabla de lectura de medidor (opcional, agua) ─────────────────────────
  if (input.lectura) {
    const L = input.lectura;
    const u = L.unidad || "m³";
    // Los rótulos son del EMISOR: el default es sanitario porque es el caso que
    // más se usa, no porque el render sepa de agua. Se sobrescriben por índice,
    // así que mandar solo el tercero deja los otros tres en su default.
    const HEADERS_DEFAULT = ["Lectura anterior", "Lectura actual", "Consumo del período", "Tarifa vigente"];
    const etiquetas = Array.isArray(L.etiquetas) ? L.etiquetas : [];
    const headers = HEADERS_DEFAULT.map((d, i) => {
      const e = etiquetas[i];
      return typeof e === "string" && e.trim() ? e.trim().slice(0, 28) : d;
    });
    const vals = [
      `${fmtCant(L.anterior)} ${u}`,
      `${fmtCant(L.actual)} ${u}`,
      `${fmtCant(L.consumo)} ${u}`,
      `$${fmtNum(L.tarifa)} / ${u}`,
    ];
    const colW = CONTENT_W / 4;
    roundRect(MARGIN, y + 4, CONTENT_W, 20, 3, { fill: C.deepGreen });
    for (let i = 0; i < 4; i++) {
      textC(headers[i], MARGIN + colW * (i + 0.5), y - 9, 8, bold, C.white);
    }
    y -= 22;
    for (let i = 0; i < 4; i++) {
      const isConsumo = i === 2;
      textC(vals[i], MARGIN + colW * (i + 0.5), y - 11, 9.5, isConsumo ? bold : font, isConsumo ? C.brandGreen : C.black);
    }
    // La FECHA en que se tomó cada lectura, bajo su valor.
    const fechas = [L.fechaAnterior, L.fechaActual];
    const subH = fechas.some(Boolean) ? 10 : 0;
    for (let i = 0; i < 2; i++) {
      if (!fechas[i]) continue;
      textC(fmtFechaCorta(fechas[i]), MARGIN + colW * (i + 0.5), y - 21, 7.5, font, C.grayLabel);
    }
    page.drawLine({ start: { x: MARGIN, y: y - 20 - subH }, end: { x: RIGHT, y: y - 20 - subH }, thickness: 0.6, color: C.line });
    y -= 34 + subH;
    // Unidades a abonar/restar en futuras facturaciones (período sin lectura).
    const abonar = Number(L.unidadesAbonar) || 0;
    if (abonar !== 0) {
      const verbo = abonar > 0 ? "a abonar" : "a restar";
      text(
        `${fmtCant(Math.abs(abonar))} ${u} ${verbo} en futuras facturaciones.`,
        MARGIN, y + 10, 8, font, C.grayLabel,
      );
      y -= 12;
    }
  }

  // ── Tabla de detalle ─────────────────────────────────────────────────────
  // vu apartado de tot lo suficiente para que "Valor unitario" y "Total" no se
  // pisen (cada monto ~45pt; antes vu-right=520 vs tot-right=560 → solapaban).
  const col = { desc: MARGIN + 12, cant: MARGIN + 300, vu: MARGIN + 360, tot: RIGHT - 12 };
  roundRect(MARGIN, y + 4, CONTENT_W, 20, 3, { fill: C.deepGreen });
  text("Detalle", col.desc, y - 9, 9, bold, C.white);
  textC("Cantidad", col.cant + 25, y - 9, 9, bold, C.white);
  textR("Valor unitario", col.vu + 70, y - 9, 9, bold, C.white);
  textR("Total", col.tot, y - 9, 9, bold, C.white);
  y -= 26;
  for (const it of input.items || []) {
    const valor = it.valor != null ? Number(it.valor) : Number(it.cantidad) * Number(it.precio);
    text(String(it.nombre ?? "").slice(0, 56), col.desc, y, 10, font, C.black);
    textC(fmtCant(it.cantidad), col.cant + 25, y, 10, font, C.black);
    textR(fmtCLP(it.precio), col.vu + 70, y, 10, font, C.black);
    textR(fmtCLP(valor), col.tot, y, 10, font, C.black);
    y -= 11;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: RIGHT, y }, thickness: 0.4, color: C.line });
    y -= 11;
  }
  y -= 6;

  // ── Totales (derecha) ────────────────────────────────────────────────────
  const t = input.totales || {};
  // Con bloques del emisor la columna de etiquetas arranca más a la izquierda:
  // los conceptos suelen ser largos ("Fondo de reposición y reinversión") y a
  // MARGIN+300 se pisaban con el monto alineado a la derecha.
  const bloques = (Array.isArray(rep.bloques) ? rep.bloques : []).filter(
    (b) => b && Array.isArray(b.filas) && b.filas.length > 0,
  );
  const totLabelX = MARGIN + (bloques.length > 0 ? 232 : 300);
  const money = (label, val, opts = {}) => {
    const f = opts.bold ? bold : font;
    text(label, totLabelX, y, 9.5, f, opts.bold ? C.deepGreen : C.gray);
    if (val != null && val !== "") textR(String(val), RIGHT, y, 9.5, f, C.black);
    y -= 13;
    if (opts.sub) {
      text(String(opts.sub).slice(0, 60), totLabelX + 8, y + 2, 7.5, font, C.grayLabel);
      y -= 10;
    }
  };

  // ── Bloques del emisor ───────────────────────────────────────────────────
  // El render no sabe qué significan: dibuja etiqueta + valor ya formateado.
  // Quién decide qué conceptos aparecen (y cuáles se omiten por ir en cero) es
  // el emisor, que es el que conoce su normativa.
  for (const b of bloques) {
    if (b.titulo) {
      text(String(b.titulo).slice(0, 46), totLabelX, y, 8, bold, C.brandGreen);
      y -= 12;
    }
    for (const fila of b.filas) {
      if (!fila || !fila.label) continue;
      if (fila.enfasis) {
        page.drawLine({ start: { x: totLabelX, y: y + 9 }, end: { x: RIGHT, y: y + 9 }, thickness: 0.5, color: C.line });
      }
      money(String(fila.label).slice(0, 46), fila.valor, { bold: !!fila.enfasis, sub: fila.sub });
    }
  }

  if (Number(t.exento) > 0) money("Monto exento", fmtCLP(t.exento));
  if (Number(t.neto) > 0) {
    money("Monto neto", fmtCLP(t.neto));
    money("IVA 19%", fmtCLP(t.iva));
  } else if (tipoDte === 41) {
    money("IVA (servicio exento)", "$ 0");
  }
  y -= 3;
  page.drawLine({ start: { x: totLabelX, y: y + 4 }, end: { x: RIGHT, y: y + 4 }, thickness: 1.2, color: C.brandGreen });
  y -= 10;
  text("TOTAL A PAGAR", totLabelX, y, 12, bold, C.deepGreen);
  textR(fmtCLP(t.total), RIGHT, y, 14, bold, C.deepGreen);
  y -= 14;
  // Notas del emisor: van a la IZQUIERDA y NO suman al total (p.ej. un acuse de
  // pagos recibidos, que informa pero no cobra).
  for (const nota of Array.isArray(rep.notas) ? rep.notas : []) {
    if (!nota) continue;
    text(String(nota).slice(0, 118), MARGIN, y, 8, font, C.grayLabel);
    y -= 10;
  }
  const afterTotalsY = y - 2;

  // ── Timbre PDF417 (izquierda) ────────────────────────────────────────────
  // Tamaño: X Dim objetivo (> mínimo SII 6.7), acotado por la envolvente ≤9×3 cm.
  // `sc` = puntos por módulo; el X Dim REAL se reporta. Quiet zone OPACA de 14pt
  // (regla SII 0,25"): aísla el código de la marca de agua y del texto vecino —
  // sin ella zxing no lo localiza (verificado: con QZ decodifica @300dpi).
  const bc = await buildTedPdf417(input.tedXml);
  const sc = Math.min(
    TARGET_XDIM_MILS / MILS_PER_PT,
    TIMBRE_MAX_H_PT / bc.height,
    TIMBRE_MAX_W_PT / bc.width,
  );
  const drawW = bc.width * sc;
  const drawH = bc.height * sc;
  const xDimMils = sc * MILS_PER_PT;
  const QZ = 14;
  const tbX = MARGIN + QZ;
  const tbTop = afterTotalsY - QZ;
  page.drawRectangle({
    x: tbX - QZ, y: tbTop - drawH - QZ, width: drawW + 2 * QZ, height: drawH + 2 * QZ, color: C.white,
  });
  page.drawSvgPath(bc.path, { x: tbX, y: tbTop, scale: sc, color: C.black });

  const capX = tbX + drawW + QZ + 4;
  let capY = tbTop - 4;
  text("Timbre Electrónico SII", capX, capY, 9, bold, C.deepGreen);
  capY -= 13;
  const displayUrl = (input.verifyUrl || DEFAULT_VERIFY_URL).replace(/^https?:\/\//, "");
  const resol = input.resolucion ? `${input.resolucion} — ` : "";
  text(`${resol}Verifique este documento en ${displayUrl}`, capX, capY, 7.5, font, C.gray);
  capY -= 12;
  text(`Folio ${input.folio} · DTE ${tipoDte} · ${String(input.emisor.razonSocial || "").slice(0, 42)}`, capX, capY, 7.5, font, C.gray);

  // Punto más bajo de la fila del timbre (incluye la quiet zone inferior).
  let belowY = Math.min(tbTop - drawH - QZ, capY) - 16;

  // ── Franja de vencimiento (opcional) ─────────────────────────────────────
  // `leyendaVencimiento` REEMPLAZA la fecha (no la acompaña) — un servicio
  // sanitario pone ahí "Corte en trámite". Por eso la franja también se dibuja
  // cuando hay leyenda y no hay fecha.
  if (input.vencimiento || rep.leyendaVencimiento) {
    const stripH = 30;
    const stripTop = belowY;
    roundRect(MARGIN, stripTop, CONTENT_W, stripH, 5, { fill: C.cardBg, border: C.cardBorder, borderW: 0.8 });
    const ty = stripTop - 19;
    const nota = input.notaPago || "Paga online, por transferencia o en caja del comité.";
    let cx = MARGIN + 14;
    if (rep.leyendaVencimiento) {
      const leyenda = String(rep.leyendaVencimiento).slice(0, 32);
      text(leyenda, cx, ty, 10, bold, C.red);
      cx += bold.widthOfTextAtSize(leyenda, 10);
    } else {
      const fecha = fmtFechaCorta(input.vencimiento);
      text("Vence: ", cx, ty, 10, font, C.gray);
      cx += font.widthOfTextAtSize("Vence: ", 10);
      text(fecha, cx, ty, 10, bold, C.deepGreen);
      cx += bold.widthOfTextAtSize(fecha, 10);
    }
    text(` · ${nota}`, cx, ty, 10, font, C.gray);
    textR(fmtCLP(t.total), RIGHT - 14, stripTop - 21, 14, bold, C.brandGreen);
    belowY -= stripH + 12;
  }

  // ── Nota legal ───────────────────────────────────────────────────────────
  // Ley 20.998 (Servicios Sanitarios Rurales) aplica SOLO a boletas de agua APR;
  // en otras (p.ej. suscripción SaaS) no corresponde citarla. Sin slice que corte
  // el texto a media palabra (antes "…Ley 20." quedaba truncado); se acota el
  // nombre del emisor para que la línea completa quepa centrada.
  const emisorNombre = String(input.emisor.razonSocial || "").slice(0, 40);
  const leyRef = input.lectura ? " · Ley 20.998" : "";
  // SIN default de marca. Antes caía a "ComunidadRural": el nombre del primer
  // cliente impreso en el documento de cualquiera que no pasara el campo. Este
  // motor es open source y renderiza DTE de terceros, así que quien emite declara
  // su plataforma o no aparece ninguna — la cláusula entera desaparece y la frase
  // sigue siendo gramatical. El slice acota junto con el del emisor para que la
  // línea quepa centrada en una sola.
  const plataforma = String(input.plataforma || "").slice(0, 24);
  const viaPlataforma = plataforma ? ` y declarado al SII a través de ${plataforma}` : "";
  const legal = `Documento tributario electrónico emitido por ${emisorNombre}${viaPlataforma}${leyRef}.`;
  textC(legal, PAGE_W / 2, belowY, 7.5, font, C.grayLabel);
  // La nota al pie ya no exige diagonal: con watermark cae al default de demo;
  // sin watermark se renderiza sola (branding de tenants white-label).
  const nota = input.watermarkNote ||
    (input.watermark
      ? "DOCUMENTO DE DEMOSTRACIÓN con datos de muestra — no constituye boleta tributaria válida."
      : null);
  if (nota) {
    textC(String(nota).slice(0, 110), PAGE_W / 2, belowY - 11, 7.5, font, C.grayLabel);
  }

  return { pdf: await doc.save(), xDimMils };
}
