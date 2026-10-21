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
import { buildQr, QR_ZONA_QUIETA } from "./qr.mjs";
import { incrustarLogoEmisor, LOGO_AIRE } from "./logo-emisor.mjs";
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

/**
 * Las líneas `<DscRcgGlobal>` de un documento, listas para dibujar.
 *
 * El SII escribe la glosa con el signo pegado ("Subsidio (-)", "Otros Descuentos
 * (-)"); en el papel el signo va adelante del monto, igual que en las filas de
 * cargos del emisor. Una línea sin monto no se dibuja: un descuento de $0, o un
 * campo que llegó vacío, es ruido en la hoja.
 *
 * `"%"` se imprime como porcentaje y no como monto a propósito: el papel no sabe
 * sobre qué base se aplicó, y un número en pesos inventado sería peor que el
 * porcentaje que el documento declara.
 */
function descuentosDelDocumento(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .filter((d) => d && Number.isFinite(Number(d.valor)) && Number(d.valor) > 0)
    .map((d) => ({
      tipo: d.tipo === "R" ? "R" : "D",
      monto: d.valorTipo === "%" ? `${Number(d.valor)}%` : fmtCLP(d.valor),
      glosa: String(d.glosa || (d.tipo === "R" ? "Recargo" : "Descuento"))
        .replace(/\s*\(\s*[-+]\s*\)\s*$/, "")
        .slice(0, 46),
    }));
}
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
 * @property {{fono?:string, horario?:string, emergencia?:string}} [contacto]
 *   Teléfono de atención y su horario, bajo los datos del emisor. `emergencia`
 *   es un segundo teléfono, en su propia línea.
 * @property {{titulo?:string, unidad?:string, puntos:{etiqueta:string, valor:number}[]}} [historial]
 *   Serie corta (hasta 12 puntos, del más viejo al más nuevo) que se dibuja en
 *   barras a la izquierda de los totales, con el último punto destacado. Con
 *   menos de 2 puntos no se dibuja.
 * @property {{titulo?:string, filas:{label:string, valor:string}[]}} [tarifario]
 *   Tabla chica de etiqueta y valor (hasta 10 filas) bajo el historial: la
 *   tarifa vigente completa, no solo lo cobrado.
 * @property {{titulo?:string, filas:{tramo:string, m3:string, valor:string, total:string}[], facturado?:{label?:string, m3:string, total:string}}} [calculoConsumo]
 *   Cálculo de consumo por tramo, con el formato del ejemplo del Manual de
 *   Facturación SSR: TRAMOS / M3 / VALOR ($) / TOTAL y una fila Facturado.
 *   Reemplaza a `tarifario` cuando viene: muestra lo cobrado, no toda la tarifa.
 * @property {string[]} [notas]
 *   Líneas informativas al pie de los totales que NO suman al total
 *   (p.ej. pagos recibidos desde la última facturación).
 * @property {{valor:string, filas?:{label:string, valor?:string, sub?:string}[]}} [totalAPagar]
 *   Cuando lo que hay que pagar NO es el total del documento (se suma un saldo
 *   anterior, la cuota de un convenio). El total del documento pasa a ser una
 *   fila ("Total de esta boleta"), debajo van `filas` (hasta 4) y el número
 *   grande y la franja de vencimiento muestran `valor`. Sin esto el papel decía
 *   "TOTAL A PAGAR" dos veces, con dos montos.
 * @property {{titulo?:string, lineas:string[], qr?:string, qrLeyenda?:string}} [pago]
 *   Cómo pagar (p.ej. la cuenta para transferir): un título y hasta 4 líneas,
 *   en un recuadro a la derecha del timbre. Cada línea se parte si no cabe.
 */

/**
 * @typedef {object} BoletaPdfInput
 * @property {39|41} tipoDte
 * @property {number} folio
 * @property {string} fechaEmision         ISO "AAAA-MM-DD"
 * @property {{rut:string, razonSocial:string, giro?:string, direccion?:string, comuna?:string, region?:string, email?:string, logo?:{base64:string}}} emisor
 *   `logo`: el logo PROPIO del emisor (JPEG o PNG en base64). Va arriba a la
 *   izquierda, al lado de sus datos (ver logo-emisor.mjs). Sin él, como siempre.
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
 * @property {{anterior:number, actual?:number|null, consumo:number, tarifa?:number, unidad?:string,
 *   fechaAnterior?:string, fechaActual?:string, unidadesAbonar?:number, estimada?:boolean,
 *   etiquetas?:string[]}} [lectura]
 *   Tabla de medidor. `fechaAnterior`/`fechaActual` son la fecha en que se tomó
 *   cada lectura; `unidadesAbonar` son las unidades a abonar (+) o restar (−) en
 *   futuras facturaciones cuando el período se facturó sin lectura.
 *
 *   `estimada`: cuando el período se facturó sin lectura, la franja muestra la
 *   lectura anterior y el consumo estimado, con "sin lectura" en la actual.
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
  // LO QUE NO SE NEGOCIA: el timbre se dibuja entero y nada lo tapa. Una boleta
  // con muchas filas (tarjeta de datos larga, cinco tramos, subsidio, saldo
  // anterior) no cabía, y el pie se dibujaba ENCIMA del timbre: sin error, y con
  // un documento que no se puede verificar. Se dibuja por niveles, del más
  // holgado al más apretado, y se entrega el primero en que todo cabe:
  //   0  normal
  //   1  menos aire ENTRE secciones (lo primero que se cede: no cuesta lectura)
  //   2  además, la escalera de cargos más junta
  //   3  además, todo a interlínea mínima (sigue sin soltar contenido)
  //   4  además, sin la tabla de tarifas
  //   5  además, sin el gráfico
  //   6  el timbre y el pie pasan a una segunda hoja (cabe siempre)
  // El nivel 3 existe porque soltar la tabla o el gráfico no acorta la columna
  // de los cargos: una boleta con saldo anterior, convenio y subsidio se pasaba
  // por menos de un punto y se iba a dos hojas con el panel izquierdo intacto.
  //
  // A dónde mandar el comprobante (`pago.comprobante`) es lo primero que se
  // suelta: si un nivel no cabe con él, se prueba ese mismo nivel sin él antes
  // de apretar más la hoja. Así una boleta nunca pierde la tabla de tarifas, el
  // gráfico ni una hoja por esa línea.
  const sinComprobante = input.representacion?.pago?.comprobante
    ? {
      ...input,
      representacion: {
        ...input.representacion,
        pago: { ...input.representacion.pago, comprobante: undefined },
      },
    }
    : null;
  for (let nivel = 0; nivel < NIVEL_SEGUNDA_HOJA; nivel++) {
    const intento = await dibujarBoleta(input, nivel);
    if (!intento.desborda) return { pdf: intento.pdf, xDimMils: intento.xDimMils, nivel };
    if (sinComprobante) {
      const sinEl = await dibujarBoleta(sinComprobante, nivel);
      if (!sinEl.desborda) return { pdf: sinEl.pdf, xDimMils: sinEl.xDimMils, nivel };
    }
  }
  const ultimo = await dibujarBoleta(sinComprobante ?? input, NIVEL_SEGUNDA_HOJA);
  return { pdf: ultimo.pdf, xDimMils: ultimo.xDimMils, nivel: NIVEL_SEGUNDA_HOJA };
}

const NIVEL_SIN_TARIFAS = 4;

/**
 * A dónde mandar el comprobante (`pago.comprobante`, un correo), al final del
 * recuadro de pago (15-oct-2026). Si no cabe, se suelta antes que cualquier otra
 * cosa (ver `generateBoletaElectronicaPdf`). Y va solo si el correo cabe entero
 * en una línea: `wrapToWidth` no parte una palabra, y un correo más ancho que el
 * texto quedaría tapado por el QR. Uno cortado es peor que ninguno.
 */
function lineasDelComprobante(pago, font, ancho, partir) {
  const correo = pago && typeof pago.comprobante === "string" ? pago.comprobante.trim() : "";
  if (!correo || /\s/.test(correo)) return [];
  if (font.widthOfTextAtSize(correo, 8.5) > ancho) return [];
  return partir(`Envía el comprobante a ${correo}`, font, 8.5, ancho);
}
const NIVEL_SIN_GRAFICO = 5;
export const NIVEL_SEGUNDA_HOJA = 6;

/**
 * La escala de espaciado de cada nivel, en puntos. Un solo lugar: antes cada
 * bloque traía su número suelto y el ritmo entre secciones iba de 14 a 32.
 *   seccion   aire entre un bloque y el siguiente
 *   dato      interlínea de las filas de las tarjetas
 *   fila      interlínea de la escalera de cargos
 *   sub       de una fila a SU línea de detalle (más cerca que de la que sigue)
 *   trasSub   de la línea de detalle a la fila siguiente
 *   corte     aire extra antes de una fila con regla (SUBTOTAL, TOTAL)
 *   aire      bajo el timbre, fuera de su zona quieta
 */
const ESPACIADO = [
  { seccion: 20, dato: 14.5, fila: 14.5, sub: 10.5, trasSub: 16, corte: 4, aire: 16 },
  { seccion: 12, dato: 12.5, fila: 13.5, sub: 9.5, trasSub: 13.5, corte: 4, aire: 8 },
  { seccion: 10, dato: 12, fila: 12, sub: 8.5, trasSub: 12, corte: 3, aire: 6 },
  { seccion: 7, dato: 11.5, fila: 11.5, sub: 8, trasSub: 11.5, corte: 2, aire: 4 },
];

async function dibujarBoleta(input, nivel) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logoEmisor = await incrustarLogoEmisor(doc, input.emisor?.logo);
  // `let`: en el último nivel el timbre y el pie se dibujan en una hoja nueva,
  // y los ayudantes de abajo escriben siempre en la hoja en curso.
  let page = doc.addPage([PAGE_W, PAGE_H]);
  const tipoDte = input.tipoDte === 41 ? 41 : 39;
  const sp = ESPACIADO[Math.min(nivel, ESPACIADO.length - 1)];

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
  // Una línea que lleva un nombre que puede ser largo (el del emisor). Entra
  // entera achicando la letra hasta `minSize`; si ni así cabe, el nombre se
  // corta en una palabra completa. Antes se cortaba a un número fijo de letras:
  // "Comité de Agua Potable Rural Quebrada Imaginaria" salía "…Quebrada Imag".
  const lineaQueCabe = (armar, nombre, maxW, size, minSize, f = font) => {
    for (let t = size; t >= minSize - 0.01; t -= 0.25) {
      if (f.widthOfTextAtSize(armar(nombre), t) <= maxW) return { texto: armar(nombre), size: t };
    }
    const palabras = String(nombre).split(/\s+/).filter(Boolean);
    while (palabras.length > 1) {
      palabras.pop();
      const corto = armar(palabras.join(" "));
      if (f.widthOfTextAtSize(corto, minSize) <= maxW) return { texto: corto, size: minSize };
    }
    return { texto: armar(String(palabras[0] ?? "").slice(0, 24)), size: minSize };
  };
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
  // Lo de la izquierda se ENVUELVE para no invadir el recuadro rojo del SII (a
  // la derecha): se acota a emisorMaxX.
  const emisorMaxX = rbX - 14;
  // Con logo, el logo va en la esquina y los datos a su derecha: el bloque no
  // crece hacia abajo (el logo es más bajo que el recuadro rojo) y nada de lo
  // que pide el manual se corre de lugar ni queda tapado.
  let ex = MARGIN;
  if (logoEmisor) {
    page.drawImage(logoEmisor.img, {
      x: MARGIN, y: y + 6 - logoEmisor.h, width: logoEmisor.w, height: logoEmisor.h,
    });
    ex = MARGIN + logoEmisor.w + LOGO_AIRE;
  }
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
  // El nombre también: "Comité de Agua Potable Rural Quebrada Alvarado" a 15pt
  // se escribía encima del recuadro. Va en dos líneas; si ni así cabe, más chico.
  const nombreEmisor = String(input.emisor.razonSocial || "");
  let nombreSize = 15;
  let nombreLineas = wrapToWidth(nombreEmisor, bold, nombreSize, emisorMaxX - ex);
  if (nombreLineas.length > 2) {
    nombreSize = 12;
    nombreLineas = wrapToWidth(nombreEmisor, bold, nombreSize, emisorMaxX - ex).slice(0, 2);
  }
  nombreLineas.forEach((linea, i) => text(linea, ex, y - 8 - i * (nombreSize + 2), nombreSize, bold, C.deepGreen));
  let ey = y - 26 - Math.max(0, nombreLineas.length - 1) * (nombreSize + 2);
  const labeled = (label, value) => {
    if (!value) return;
    const lab = `${label}: `;
    const labW = bold.widthOfTextAtSize(lab, 9.5);
    text(lab, ex, ey, 9.5, bold, C.gray);
    const lines = wrapToWidth(value, font, 9.5, emisorMaxX - ex - labW);
    text(lines[0] ?? "", ex + labW, ey, 9.5, font, C.gray);
    ey -= 15;
    for (let i = 1; i < lines.length; i++) {
      text(lines[i], ex + labW, ey, 9.5, font, C.gray);
      ey -= 15;
    }
  };
  labeled("Giro", input.emisor.giro);
  labeled("Dirección", input.emisor.direccion);
  const reg = [input.emisor.region, input.emisor.email].filter(Boolean).join(" · ");
  if (reg) { text(reg, ex, ey, 9.5, font, C.gray); ey -= 15; }
  // §2.i — teléfono de atención de consultas y emergencias + horario de atención.
  // El dato existe hace rato en community_billing_settings y el chequeo 14 del
  // validador lo exige; hasta ahora no se imprimía.
  // Contacto de atención. En dos líneas: juntas se pasan del ancho disponible y
  // el wrap deja el horario colgando bajo el recuadro rojo.
  const rep = input.representacion || {};
  // Con un teléfono de emergencias propio, cada número dice para qué es; con
  // uno solo, ese atiende las dos cosas.
  const emergencia = rep.contacto?.emergencia;
  labeled(emergencia ? "Atención de usuarios" : "Atención y emergencias", rep.contacto?.fono);
  labeled("Horario de atención", rep.contacto?.horario);
  labeled("Emergencias", emergencia);

  // `ey` ya bajó una interlínea tras la última fila del emisor: se descuenta
  // para que el aire real sea el de la escala.
  y = Math.min(ey + 9, rbTop - rbH) - sp.seccion;

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
  // Con muchas filas, las que sobran pasan a la tarjeta del receptor, que tiene
  // aire: una sola columna de diez filas se llevaba 170pt de la hoja. Las tres
  // primeras (emisión, período, medidor) se quedan siempre a la derecha.
  const filaDato = sp.dato;
  const altoDerecha = (n) => 34 + Math.max(0, n - 1) * filaDato + 12;
  const altoIzquierda = (n) => (n > 0 ? 79 + (n - 1) * filaDato + 12 : 76);
  let aLaDerecha = datos.length;
  for (let k = datos.length; k >= Math.min(3, datos.length); k--) {
    const alto = Math.max(altoDerecha(k), altoIzquierda(datos.length - k));
    if (alto < Math.max(altoDerecha(aLaDerecha), altoIzquierda(datos.length - aLaDerecha))) aLaDerecha = k;
  }
  const datosDerecha = datos.slice(0, aLaDerecha);
  const datosIzquierda = datos.slice(aLaDerecha);
  const cardH = Math.max(76, altoDerecha(datosDerecha.length), altoIzquierda(datosIzquierda.length));
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
  cy -= 18;
  for (const [label, value] of datosIzquierda) {
    text(`${label}: `, MARGIN + 12, cy, 9, bold, C.gray);
    text(String(value), MARGIN + 12 + bold.widthOfTextAtSize(`${label}: `, 9), cy, 9, font, C.black);
    cy -= filaDato;
  }
  // Datos de la boleta
  const dX = MARGIN + cardW + gap + 12;
  let dy = cardTop - 18;
  text("DATOS DE LA BOLETA", dX, dy, 7.5, bold, C.brandGreen);
  dy -= 16;
  for (const [label, value] of datosDerecha) {
    text(`${label}: `, dX, dy, 9, bold, C.gray);
    text(String(value), dX + bold.widthOfTextAtSize(`${label}: `, 9), dy, 9, font, C.black);
    dy -= filaDato;
  }

  y = cardTop - cardH - sp.seccion;

  // ── Tabla de lectura de medidor (opcional, agua) ─────────────────────────
  if (input.lectura) {
    const L = input.lectura;
    const u = L.unidad || "m³";
    // Los rótulos son del EMISOR: el default es sanitario porque es el caso que
    // más se usa, no porque el render sepa de agua. Se sobrescriben por índice,
    // así que mandar solo el tercero deja los otros tres en su default.
    const HEADERS_DEFAULT = ["Lectura anterior", "Lectura actual", "Consumo del período", "Tarifa vigente"];
    const etiquetas = Array.isArray(L.etiquetas) ? L.etiquetas : [];
    // La tarifa en la franja es OPCIONAL: el Manual de Facturación SSR no la
    // exige (solo lecturas y consumo). Cuando el emisor no la manda, la franja
    // va con 3 columnas y el desglose por tramo queda en "Cálculo de consumo".
    const conTarifa = L.tarifa != null && Number.isFinite(Number(L.tarifa)) && Number(L.tarifa) > 0;
    const esEstimada = L.estimada === true;
    const nCols = conTarifa ? 4 : 3;
    const baseHeaders = esEstimada
      ? ["Lectura anterior", "Lectura actual", "Consumo estimado"]
      : HEADERS_DEFAULT;
    const headers = baseHeaders.slice(0, nCols).map((d, i) => {
      const e = etiquetas[i];
      return typeof e === "string" && e.trim() ? e.trim().slice(0, 28) : d;
    });
    const vals = [
      `${fmtCant(L.anterior)} ${u}`,
      esEstimada ? "sin lectura" : `${fmtCant(L.actual)} ${u}`,
      `${fmtCant(L.consumo)} ${u}`,
      ...(conTarifa ? [`$${fmtNum(L.tarifa)} / ${u}`] : []),
    ];
    const colW = CONTENT_W / nCols;
    roundRect(MARGIN, y + 4, CONTENT_W, 20, 3, { fill: C.brandGreen });
    for (let i = 0; i < nCols; i++) {
      textC(headers[i], MARGIN + colW * (i + 0.5), y - 9, 8, bold, C.white);
    }
    y -= 22;
    for (let i = 0; i < nCols; i++) {
      const isConsumo = i === 2;
      textC(vals[i], MARGIN + colW * (i + 0.5), y - 11, 9.5, isConsumo ? bold : font, isConsumo ? C.brandGreen : C.black);
    }
    // La FECHA en que se tomó cada lectura, bajo su valor.
    const fechas = [L.fechaAnterior, esEstimada ? null : L.fechaActual];
    const subH = fechas.some(Boolean) ? 10 : 0;
    for (let i = 0; i < 2; i++) {
      if (!fechas[i]) continue;
      textC(fmtFechaCorta(fechas[i]), MARGIN + colW * (i + 0.5), y - 21, 7.5, font, C.grayLabel);
    }
    page.drawLine({ start: { x: MARGIN, y: y - 20 - subH }, end: { x: RIGHT, y: y - 20 - subH }, thickness: 0.6, color: C.line });
    y -= 20 + subH + sp.seccion;
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
  roundRect(MARGIN, y + 4, CONTENT_W, 20, 3, { fill: C.brandGreen });
  text("Detalle", col.desc, y - 9, 9, bold, C.white);
  textC("Cantidad", col.cant + 25, y - 9, 9, bold, C.white);
  textR("Valor unitario", col.vu + 70, y - 9, 9, bold, C.white);
  textR("Total", col.tot, y - 9, 9, bold, C.white);
  // Barra de 20pt que termina en y-16: la primera fila va 15pt más abajo, con
  // el mismo aire sobre la letra que el que queda bajo ella hasta la regla.
  y -= 31;
  for (const it of input.items || []) {
    const valor = it.valor != null ? Number(it.valor) : Number(it.cantidad) * Number(it.precio);
    text(String(it.nombre ?? "").slice(0, 56), col.desc, y, 10, font, C.black);
    textC(fmtCant(it.cantidad), col.cant + 25, y, 10, font, C.black);
    textR(fmtCLP(it.precio), col.vu + 70, y, 10, font, C.black);
    textR(fmtCLP(valor), col.tot, y, 10, font, C.black);
    y -= 10;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: RIGHT, y }, thickness: 0.4, color: C.line });
    y -= 16;
  }
  // Las boletas con muchas notas (aviso de corte + deuda + pagos) tienen menos
  // aire disponible: se les da la mitad, para no empujarlas a una segunda hoja.
  const extraGap = (Array.isArray(rep.notas) ? rep.notas.length : 0) >= 4 ? 5 : 10;
  y += 15 - sp.seccion - extraGap;

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
    if (opts.sub) {
      // La línea de detalle va pegada a SU fila, y la que sigue toma distancia:
      // a medio camino no se sabía de cuál de las dos era.
      y -= sp.sub;
      text(String(opts.sub).slice(0, 60), totLabelX + 8, y, 7.5, font, C.grayLabel);
      y -= sp.trasSub;
    } else {
      y -= sp.fila;
    }
  };

  // ── Panel izquierdo: historial y tarifario (opcionales) ──────────────────
  // La columna a la izquierda de los totales queda vacía hasta el timbre. Ahí
  // van, si el emisor los manda, el consumo de los últimos meses en barras y su
  // tarifa vigente. El render no sabe de agua: dibuja puntos y filas.
  const panelX = MARGIN;
  const panelW = totLabelX - MARGIN - 20;
  let panelY = y;
  const puntos = (Array.isArray(rep.historial?.puntos) ? rep.historial.puntos : [])
    .filter((p) => p && Number.isFinite(Number(p.valor)) && Number(p.valor) >= 0)
    .slice(-12);
  if (puntos.length >= 2 && nivel < NIVEL_SIN_GRAFICO) {
    // La unidad va junto al título: suelta en la otra esquina no se leía de qué era.
    const unidad = String(rep.historial.unidad || "").slice(0, 6);
    const tituloHist = String(rep.historial.titulo || "Historial").slice(0, 46);
    text(tituloHist, panelX, panelY, 8, bold, C.brandGreen);
    if (unidad) {
      text(` (${unidad})`, panelX + bold.widthOfTextAtSize(tituloHist, 8), panelY, 8, font, C.grayLabel);
    }
    panelY -= 10;
    const chartH = 46;
    const slot = panelW / puntos.length;
    const barW = Math.min(14, slot * 0.62);
    const max = Math.max(...puntos.map((p) => Number(p.valor)), 0);
    // Línea de base: una barra de 0 se ve como "sin consumo", no como un hueco.
    const baseY = panelY - 8 - chartH;
    page.drawLine({ start: { x: panelX, y: baseY }, end: { x: panelX + panelW, y: baseY }, thickness: 0.6, color: C.line });
    puntos.forEach((p, i) => {
      const v = Number(p.valor);
      const h = max > 0 ? Math.max(v > 0 ? 1.5 : 0, (v / max) * chartH) : 0;
      const cx = panelX + slot * (i + 0.5);
      const last = i === puntos.length - 1;
      if (h > 0) {
        page.drawRectangle({
          x: cx - barW / 2, y: baseY, width: barW, height: h,
          color: last ? C.brandGreen : C.cardBorder,
        });
      }
      // El valor arriba de su barra: el gráfico se lee sin eje.
      textC(fmtCant(v), cx, baseY + h + 2, 6, last ? bold : font, last ? C.deepGreen : C.gray);
      textC(String(p.etiqueta ?? "").slice(0, 4), cx, baseY - 8, 6, last ? bold : font, C.gray);
    });
    panelY = baseY - 26;
  }
  // Cálculo de consumo por tramo (ejemplo del Manual de Facturación SSR).
  // Reemplaza la tabla de tarifas: muestra los tramos cobrados con m³, valor
  // unitario y total, y la fila Facturado.
  const calculo = rep.calculoConsumo;
  const filasCalculo = (Array.isArray(calculo?.filas) ? calculo.filas : [])
    .filter((f) => f && f.tramo)
    .slice(0, 7);
  if (filasCalculo.length > 0) {
    text(String(calculo.titulo || "Cálculo de consumo").slice(0, 46), panelX, panelY, 8, bold, C.brandGreen);
    panelY -= 13;
    const cTramo = panelX + 3;
    const cM3 = panelX + panelW * 0.46;
    const cValor = panelX + panelW * 0.65;
    const cTotal = panelX + panelW;
    page.drawRectangle({ x: panelX, y: panelY - 1, width: panelW, height: 11, color: C.brandGreen });
    text("TRAMOS", cTramo, panelY + 2, 6.2, bold, C.white);
    textR("M3", cM3, panelY + 2, 6.2, bold, C.white);
    textR("VALOR ($)", cValor, panelY + 2, 6.2, bold, C.white);
    textR("TOTAL", cTotal, panelY + 2, 6.2, bold, C.white);
    panelY -= 13;
    for (const f of filasCalculo) {
      text(String(f.tramo).slice(0, 22), cTramo, panelY, 6.5, font, C.gray);
      textR(String(f.m3 ?? "").slice(0, 8), cM3, panelY, 6.5, font, C.black);
      textR(String(f.valor ?? "").slice(0, 12), cValor, panelY, 6.5, font, C.black);
      textR(String(f.total ?? "").slice(0, 12), cTotal, panelY, 6.5, font, C.black);
      panelY -= 10.5;
    }
    const fact = calculo.facturado;
    if (fact) {
      page.drawLine({ start: { x: panelX, y: panelY + 6 }, end: { x: panelX + panelW, y: panelY + 6 }, thickness: 0.5, color: C.line });
      text(String(fact.label || "Facturado").slice(0, 22), cTramo, panelY - 2, 7, bold, C.black);
      textR(String(fact.m3 ?? "").slice(0, 8), cM3, panelY - 2, 7, bold, C.black);
      textR(String(fact.total ?? "").slice(0, 12), cTotal, panelY - 2, 7, bold, C.black);
      panelY -= 13;
    }
    panelY -= 6;
  }
  const filasTarifa = calculo ? [] : (Array.isArray(rep.tarifario?.filas) ? rep.tarifario.filas : [])
    .filter((f) => f && f.label && f.valor)
    .slice(0, 10);
  if (filasTarifa.length > 0 && nivel < NIVEL_SIN_TARIFAS) {
    text(String(rep.tarifario.titulo || "Tarifas").slice(0, 46), panelX, panelY, 8, bold, C.brandGreen);
    panelY -= 12;
    for (const f of filasTarifa) {
      text(String(f.label).slice(0, 46), panelX, panelY, 7.5, font, C.gray);
      textR(String(f.valor).slice(0, 24), panelX + panelW, panelY, 7.5, font, C.black);
      panelY -= 10.5;
    }
    panelY -= 4;
  }
  const conPanel = panelY < y;

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
        // La regla va en el aire extra, no rozando la fila de arriba.
        y -= sp.corte;
        page.drawLine({ start: { x: totLabelX, y: y + 10 }, end: { x: RIGHT, y: y + 10 }, thickness: 0.5, color: C.line });
      }
      money(String(fila.label).slice(0, 46), fila.valor, { bold: !!fila.enfasis, sub: fila.sub });
    }
  }

  // ── Descuentos y recargos globales del DTE (Formato SII, DscRcgGlobal) ───
  // Van acá: entre los conceptos del emisor y los totales tributarios, que es
  // donde entran en la cuenta del documento. El `<DscRcgGlobal>` del XML ya está
  // restado (o sumado) en MntExe/MntTotal, así que estas filas son las que
  // explican por qué el total no es la suma del detalle. Sin descuentos no se
  // dibuja nada: la boleta sin ellos sale exactamente igual que siempre.
  for (const d of descuentosDelDocumento(input.descuentosGlobales)) {
    money(d.glosa, `${d.tipo === "R" ? "+" : "-"} ${d.monto}`);
  }

  if (Number(t.exento) > 0) money("Monto exento", fmtCLP(t.exento));
  if (Number(t.neto) > 0) {
    money("Monto neto", fmtCLP(t.neto));
    money("IVA 19%", fmtCLP(t.iva));
  } else if (tipoDte === 41) {
    money("IVA (servicio exento)", "$ 0");
  }
  // Lo que hay que pagar no siempre es el total del documento: con un saldo
  // anterior o la cuota de un convenio, el documento es una fila más y el número
  // grande es la suma. Un solo "TOTAL A PAGAR" en la hoja.
  const tap = rep.totalAPagar && typeof rep.totalAPagar === "object" && rep.totalAPagar.valor
    ? rep.totalAPagar
    : null;
  const totalAPagar = tap ? String(tap.valor).slice(0, 24) : fmtCLP(t.total);
  if (tap) {
    y -= sp.corte;
    page.drawLine({ start: { x: totLabelX, y: y + 10 }, end: { x: RIGHT, y: y + 10 }, thickness: 0.5, color: C.line });
    money("Total de esta boleta", fmtCLP(t.total), { bold: true });
    for (const fila of (Array.isArray(tap.filas) ? tap.filas : []).slice(0, 4)) {
      if (!fila || !fila.label) continue;
      money(String(fila.label).slice(0, 46), fila.valor, { sub: fila.sub });
    }
  }
  y -= 3;
  page.drawLine({ start: { x: totLabelX, y: y + 4 }, end: { x: RIGHT, y: y + 4 }, thickness: 1.2, color: C.brandGreen });
  y -= 10;
  text("TOTAL A PAGAR", totLabelX, y, 12, bold, C.deepGreen);
  textR(totalAPagar, RIGHT, y, 14, bold, C.deepGreen);
  // 17pt: la nota de abajo corre por la izquierda, bajo el rótulo del total.
  y -= 18;
  // Lo que sigue (notas y timbre) va bajo lo MÁS bajo de las dos columnas: con
  // pocos cargos, el panel izquierdo termina más abajo que los totales.
  if (conPanel) y = Math.min(y, panelY);
  // Notas del emisor: van a la IZQUIERDA y NO suman al total (p.ej. un acuse de
  // pagos recibidos, que informa pero no cobra).
  for (const nota of Array.isArray(rep.notas) ? rep.notas : []) {
    if (!nota) continue;
    text(String(nota).slice(0, 118), MARGIN, y, 8, font, C.grayLabel);
    y -= 14.5;
  }
  let afterTotalsY = y - 7;

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
  // ¿Cabe el timbre con su zona quieta, y debajo la franja y el pie? Lo que
  // ocupa hacia abajo: la zona quieta de arriba, el código (o las tres líneas
  // de su leyenda, si son más altas), la de abajo y 16pt de aire.
  const reservaPie = 12 +
    (input.watermarkNote || input.watermark ? 11 : 0) +
    (input.vencimiento || rep.leyendaVencimiento ? 42 : 0);
  const aireBajoTimbre = sp.aire;
  // Cómo pagar: un recuadro a la derecha del timbre, pero pegado ABAJO: su
  // borde inferior queda al mismo nivel que el de la leyenda del timbre, justo
  // arriba de la franja de vencimiento (pedido del founder, 21-oct-2026). Antes
  // flotaba arriba, desalineado con la leyenda.
  const pagoX = tbX + drawW + QZ + 4;
  const PAGO_PAD = 7;
  const pagoAncho = RIGHT - pagoX;
  // Un QR del emisor (su cuenta, su portal de pago), adentro del recuadro y a la
  // derecha del texto. Es opcional: sin `pago.qr` el recuadro queda como estaba.
  // Con su zona quieta mide 62 pt (2,2 cm): un QR de 37 módulos sale a unos
  // 0,48 mm por módulo, que una cámara de teléfono lee sin acercarse.
  const QR_LADO = 58;
  const qrTexto = rep.pago && typeof rep.pago.qr === "string" ? rep.pago.qr.trim() : "";
  const qr = qrTexto ? await buildQr(qrTexto) : null;
  const qrLeyenda = qr && rep.pago.qrLeyenda ? String(rep.pago.qrLeyenda).slice(0, 22) : "";
  // El texto cede el ancho del QR. Como se parte en más líneas, se le dejan más
  // antes de cortar: lo que no puede pasar es que se pierda el número de cuenta.
  // Hasta cinco líneas de entrada: una comunidad con dos cuentas de titulares
  // distintos manda cada cuenta con su titular y, al final, qué escribir
  // (14-oct-2026). Si el recuadro crece más que el timbre, la hoja se aprieta
  // por niveles como con cualquier otra cosa que no cabe.
  const pagoAnchoTexto = pagoAncho - 2 * PAGO_PAD - (qr ? QR_LADO + PAGO_PAD : 0);
  const pagoLineas = (rep.pago && Array.isArray(rep.pago.lineas) ? rep.pago.lineas : [])
    .filter((l) => typeof l === "string" && l.trim())
    .slice(0, 5)
    .flatMap((l) => wrapToWidth(l.trim(), font, 8.5, pagoAnchoTexto))
    .slice(0, qr ? 10 : 8)
    .concat(lineasDelComprobante(rep.pago, font, pagoAnchoTexto, wrapToWidth));
  const pagoTitulo = (pagoLineas.length > 0 || qr) && rep.pago.titulo ? String(rep.pago.titulo).slice(0, qr ? 32 : 46) : "";
  const pagoAltoTexto = pagoLineas.length > 0 || pagoTitulo
    ? (pagoTitulo ? 12 : 0) + pagoLineas.length * 11.5 - (pagoLineas.length > 0 ? 3 : 0)
    : 0;
  const pagoAltoQr = qr ? QR_LADO + (qrLeyenda ? 9 : 0) : 0;
  const pagoAlto = pagoLineas.length > 0 || qr ? 2 * PAGO_PAD + Math.max(pagoAltoTexto, pagoAltoQr) : 0;

  // Leyenda del timbre DEBAJO del código, en su misma columna. Se parte al
  // ancho del PDF417 para no invadir el recuadro de pago.
  const displayUrl = (input.verifyUrl || DEFAULT_VERIFY_URL).replace(/^https?:\/\//, "");
  const resol = input.resolucion ? `${input.resolucion} — ` : "";
  const verifyLineas = wrapToWidth(
    `${resol}Verifique este documento en ${displayUrl}`,
    font, 7.5, drawW,
  );
  const folioLineas = wrapToWidth(
    `Folio ${input.folio} · DTE ${tipoDte} · ${String(input.emisor.razonSocial || "").trim()}`,
    font, 7, drawW,
  );
  const altoCaption = 14 + verifyLineas.length * 10 + 1 + folioLineas.length * 9.5 + 4;
  const altoPago = pagoAlto > 0 ? pagoAlto : 0;
  const altoTimbre = QZ + drawH + QZ + 6 + altoCaption + aireBajoTimbre;
  let desborda = afterTotalsY - altoTimbre < reservaPie;
  if (desborda && nivel >= NIVEL_SEGUNDA_HOJA) {
    page = doc.addPage([PAGE_W, PAGE_H]);
    afterTotalsY = PAGE_H - MARGIN;
    desborda = false;
  }
  const tbTop = afterTotalsY - QZ;
  page.drawRectangle({
    x: tbX - QZ, y: tbTop - drawH - QZ, width: drawW + 2 * QZ, height: drawH + 2 * QZ, color: C.white,
  });
  page.drawSvgPath(bc.path, { x: tbX, y: tbTop, scale: sc, color: C.black });

  let capY = tbTop - drawH - QZ - 6;
  text("Timbre Electrónico SII", tbX, capY, 9, bold, C.deepGreen);
  capY -= 14;
  for (const linea of verifyLineas) {
    text(linea, tbX, capY, 7.5, font, C.gray);
    capY -= 10;
  }
  capY -= 1;
  for (const linea of folioLineas) {
    text(linea, tbX, capY, 7, font, C.gray);
    capY -= 9.5;
  }
  const capBottom = capY;
  if (pagoAlto > 0) {
    // Borde inferior alineado con el de la leyenda del timbre.
    const pagoTop = capBottom + pagoAlto;
    roundRect(pagoX, pagoTop, pagoAncho, pagoAlto, 5, { fill: C.cardBg, border: C.cardBorder, borderW: 0.8 });
    let py = pagoTop - PAGO_PAD - 6;
    if (pagoTitulo) {
      text(pagoTitulo, pagoX + PAGO_PAD, py, 8, bold, C.brandGreen);
      py -= 12;
    }
    for (const linea of pagoLineas) {
      text(linea, pagoX + PAGO_PAD, py, 8.5, font, C.gray);
      py -= 11.5;
    }
    if (qr) {
      // Sobre blanco, con su zona quieta: el fondo del recuadro es de color.
      const qx = pagoX + pagoAncho - PAGO_PAD - QR_LADO;
      const qTop = pagoTop - PAGO_PAD;
      const esc = QR_LADO / (qr.size + 2 * QR_ZONA_QUIETA);
      page.drawRectangle({ x: qx, y: qTop - QR_LADO, width: QR_LADO, height: QR_LADO, color: C.white });
      page.drawSvgPath(qr.path, {
        x: qx + QR_ZONA_QUIETA * esc, y: qTop - QR_ZONA_QUIETA * esc, scale: esc, color: C.black,
      });
      // En negrita y en el verde del título del recuadro: es la invitación a pagar,
      // no una nota al pie (founder, 15-oct-2026). Antes iba en gris y sin negrita.
      if (qrLeyenda) textC(qrLeyenda, qx + QR_LADO / 2, qTop - QR_LADO - 7, 7.5, bold, C.brandGreen);
    }
  }

  // Punto más bajo de la fila del timbre (incluye la quiet zone inferior).
  let belowY = capBottom - aireBajoTimbre;

  // La nota al pie ya no exige diagonal: con watermark cae al default de demo;
  // sin watermark se renderiza sola (branding de tenants white-label).
  const nota = input.watermarkNote ||
    (input.watermark
      ? "DOCUMENTO DE DEMOSTRACIÓN con datos de muestra — no constituye boleta tributaria válida."
      : null);
  // El pie no se sale de la hoja. Con una boleta larga (tramos + subsidio +
  // contacto) la línea legal caía a 8pt del borde y la nota quedaba cortada. Se
  // reserva abajo lo que ocupan la franja y el pie, y lo que falte sale del aire
  // bajo el timbre (16pt, sin tocar su quiet zone).
  const conFranja = Boolean(input.vencimiento || rep.leyendaVencimiento);
  belowY = Math.max(belowY, 12 + (nota ? 11 : 0) + (conFranja ? 42 : 0));

  // ── Franja de vencimiento (opcional) ─────────────────────────────────────
  // `leyendaVencimiento` REEMPLAZA la fecha (no la acompaña) — un servicio
  // sanitario pone ahí "Corte en trámite". Por eso la franja también se dibuja
  // cuando hay leyenda y no hay fecha.
  if (conFranja) {
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
    textR(totalAPagar, RIGHT - 14, stripTop - 21, 14, bold, C.brandGreen);
    belowY -= stripH + 12;
  }

  // ── Nota legal ───────────────────────────────────────────────────────────
  // Ley 20.998 (Servicios Sanitarios Rurales) aplica SOLO a boletas de agua APR;
  // en otras (p.ej. suscripción SaaS) no corresponde citarla. Sin slice que corte
  // el texto a media palabra (antes "…Ley 20." quedaba truncado); se acota el
  // nombre del emisor para que la línea completa quepa centrada.
  const leyRef = input.lectura ? " · Ley 20.998" : "";
  // SIN default de marca. Antes caía a "ComunidadRural": el nombre del primer
  // cliente impreso en el documento de cualquiera que no pasara el campo. Este
  // motor es open source y renderiza DTE de terceros, así que quien emite declara
  // su plataforma o no aparece ninguna — la cláusula entera desaparece y la frase
  // sigue siendo gramatical. El slice acota junto con el del emisor para que la
  // línea quepa centrada en una sola.
  const plataforma = String(input.plataforma || "").slice(0, 24);
  const viaPlataforma = plataforma ? ` y declarado al SII a través de ${plataforma}` : "";
  const legal = lineaQueCabe(
    (nombre) => `Documento tributario electrónico emitido por ${nombre}${viaPlataforma}${leyRef}.`,
    String(input.emisor.razonSocial || "").trim(), CONTENT_W, 7.5, 6.5,
  );
  textC(legal.texto, PAGE_W / 2, belowY, legal.size, font, C.grayLabel);
  if (nota) {
    textC(String(nota).slice(0, 110), PAGE_W / 2, belowY - 11, 7.5, font, C.grayLabel);
  }

  return { pdf: await doc.save(), xDimMils, desborda };
}
