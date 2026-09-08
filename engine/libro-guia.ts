// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Arma y firma el Libro de Guías de Despacho Electrónicas (`LibroGuia` v1.0, `EnvioLibro`
 * con XMLDSig sobre C14N real): el tercer libro del set de certificación de factura, el que
 * resume las guías 52 de un período.
 *
 * Carátula fija en `ESPECIAL`/`TOTAL` y, a diferencia del IECV, sin `TipoOperacion`. El resumen
 * se deriva solo del detalle: la guía con `anulado` cuenta únicamente en `TotGuiaAnulada`, y
 * `TotTraslado` agrupa por `tpoOper` salvo la venta (1), porque el enum `TpoTraslado` del XSD
 * parte en 2; sin `tmstFirma`, el `TmstFirma` queda el 1° del período a las 12:00. Revienta con
 * `envioId` que no calce su patrón de `xs:ID`, detalle vacío, línea del XML firmado sobre 4000
 * chars (tope 4096 del gateway legacy) o cualquier texto con un carácter fuera de ISO-8859-1
 * —no sanea nada: pásalo antes por `sanitizeSiiText` de `@ruraldte/engine/sii-text`—. Lo que sí
 * ajusta callado: `razonSocial` a 50 chars y los montos en 0, que no se emiten. No valida contra
 * el XSD ni envía nada al SII, y lo que se sube es `bytes` (ISO-8859-1), no el string.
 *
 * @example
 * ```ts
 * import { buildSignedLibroGuia } from "@ruraldte/engine/libro-guia";
 *
 * // pfx + password se usan solo para firmar, en memoria; no salen en el resultado.
 * const { bytes } = buildSignedLibroGuia({
 *   rutEmisorLibro: "76543210-K",
 *   rutEnvia: "22222222-2",
 *   periodoTributario: "2026-06",
 *   fchResol: "2026-06-08",
 *   nroResol: 0,
 *   folioNotificacion: 3,
 *   envioId: "LGD_76543210K_202606",
 *   detalles: [
 *     // venta facturada: única que suma en TotGuiaVenta/TotMntGuiaVta
 *     {
 *       folio: 1, tpoOper: 1, fecha: "2026-06-14", rut: "77777777-7",
 *       razonSocial: "Comercial Ejemplo", montoNeto: 100000, tasaIva: 19,
 *       iva: 19000, montoTotal: 119000,
 *     },
 *     // traslado interno: va en TotTraslado con TpoTraslado 5
 *     { folio: 2, tpoOper: 5, fecha: "2026-06-15", rut: "76543210-K", montoTotal: 50000 },
 *     // anulada post-envío: solo cuenta en TotGuiaAnulada
 *     { folio: 3, anulado: 2, tpoOper: 1, fecha: "2026-06-16", rut: "77777777-7" },
 *   ],
 * }, pfxBytes, pfxPassword);
 * ```
 *
 * @module
 */
// ============================================================================
// libro-guia.ts — Libro de Guías de Despacho Electrónicas firmado.
// ============================================================================
//
// 3er libro requerido por la cert de factura (set 4897297). Mismo patrón que
// libro-iecv.ts (EnvioLibro firmado), pero schema propio `LibroGuia_v10.xsd` y
// estructura específica de guías: la carátula NO lleva TipoOperacion; el resumen
// totaliza guías de venta + anuladas + traslados por tipo; el detalle marca
// `Anulado` (1 pre-envío / 2 post-envío / 3 recepción parcial) y `TpoOper`
// (1 venta … 5 traslado interno … 7 devolución).
//
// Del set: caso 2 = guía facturada en el período (venta), caso 3 = guía anulada.
// ============================================================================

import { encodeLatin1, signSiiXml } from "./xml-signature.ts";

const SII_NS = "http://www.sii.cl/SiiDte";
const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";

function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function el(tag: string, value: string | number): string {
  return `<${tag}>${escText(String(value))}</${tag}>`;
}

/** Tipo de operación/traslado de la guía (TpoOper). */
export type GuiaTpoOper = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * Una guía de despacho del período, como fila del detalle del libro. Solo `folio` es
 * obligatorio; `montoNeto`, `iva` y `montoTotal` van en pesos enteros y se omiten del XML si
 * quedan en 0, y una guía con `anulado` solo suma en `TotGuiaAnulada`: su fila igual se emite,
 * pero no entra en `TotGuiaVenta`, `TotMntGuiaVta` ni `TotTraslado`.
 */
export type LibroGuiaDetalle = {
  /** Folio de la guía (Folio). */
  folio: number;
  /** Anulado: 1 pre-envío SII · 2 post-envío SII · 3 recepción parcial. */
  anulado?: 1 | 2 | 3;
  /** Tipo de operación/traslado (TpoOper): 1 venta … 5 traslado interno … 7 devolución. */
  tpoOper?: GuiaTpoOper;
  /** Fecha del documento AAAA-MM-DD (FchDoc). */
  fecha?: string;
  /** RUT de la contraparte (RUTDoc). */
  rut?: string;
  /** Razón social de la contraparte (RznSoc). */
  razonSocial?: string;
  /** Monto neto (MntNeto). */
  montoNeto?: number;
  /** Tasa de IVA (TasaImp). */
  tasaIva?: number;
  /** Monto IVA (IVA). */
  iva?: number;
  /** Monto total (MntTotal). */
  montoTotal?: number;
};

/**
 * Carátula y detalle con que se arma el Libro de Guías. `envioId` viaja como `xs:ID` del
 * `EnvioLibro` —parte con letra o `_` y sigue con letras, dígitos, `_`, `.` o `-`— y `detalles`
 * no puede ir vacío: cualquiera de los dos hace fallar `buildSignedLibroGuia`. `TipoLibro`
 * (`ESPECIAL`) y `TipoEnvio` (`TOTAL`) son fijos, no se pasan acá.
 */
export type LibroGuiaInput = {
  rutEmisorLibro: string;
  rutEnvia: string;
  /** Período tributario AAAA-MM. */
  periodoTributario: string;
  fchResol: string;
  nroResol: number;
  /** Folio de notificación (el set asigna uno; ver instrucciones). */
  folioNotificacion: number;
  envioId: string;
  detalles: LibroGuiaDetalle[];
  /** Timestamp de firma (TmstFirma, AAAA-MM-DDThh:mm:ss). Default: 1° del período. */
  tmstFirma?: string;
};

/**
 * El libro ya firmado: `xml` es el string Unicode con declaración `ISO-8859-1` y `bytes` es esa
 * misma cadena codificada en Latin-1. Al SII sube `bytes`, no el string.
 */
export type BuildLibroResult = { xml: string; bytes: Uint8Array };

/** ResumenPeriodo (orden XSD): [TotGuiaAnulada], TotGuiaVenta, TotMntGuiaVta, [TotTraslado…]. */
function buildResumen(detalles: LibroGuiaDetalle[]): string {
  // Las guías anuladas se cuentan SOLO en TotGuiaAnulada (no en venta ni traslado).
  const activas = detalles.filter((d) => d.anulado === undefined);
  const ventas = activas.filter((d) => d.tpoOper === 1);
  const totMntVta = ventas.reduce((s, d) => s + (d.montoTotal ?? 0), 0);
  const anuladas = detalles.filter((d) => d.anulado !== undefined).length;

  const parts: string[] = [];
  if (anuladas > 0) parts.push(el("TotGuiaAnulada", anuladas));
  parts.push(el("TotGuiaVenta", ventas.length));
  parts.push(el("TotMntGuiaVta", totMntVta));

  // TotTraslado por tipo (CantGuia + MntGuia), ascendente, máx 6 (solo activas).
  // El XSD de TpoTraslado enumera {2..9}: la VENTA (tpoOper 1) NO va acá — se cuenta
  // solo en TotGuiaVenta/TotMntGuiaVta (verificado vs LibroGuia_v10.xsd con xmllint).
  const byTipo = new Map<number, { cant: number; mnt: number }>();
  for (const d of activas) {
    if (d.tpoOper === undefined || d.tpoOper === 1) continue;
    const t = byTipo.get(d.tpoOper) ?? { cant: 0, mnt: 0 };
    t.cant += 1;
    t.mnt += d.montoTotal ?? 0;
    byTipo.set(d.tpoOper, t);
  }
  for (const [tpo, agg] of [...byTipo.entries()].sort((a, b) => a[0] - b[0])) {
    parts.push(
      `<TotTraslado>${el("TpoTraslado", tpo)}${el("CantGuia", agg.cant)}${
        agg.mnt > 0 ? el("MntGuia", agg.mnt) : ""
      }</TotTraslado>`,
    );
  }
  return `<ResumenPeriodo>${parts.join("")}</ResumenPeriodo>`;
}

/** Detalle (orden XSD): Folio, [Anulado], [TpoOper], [FchDoc], [RUTDoc], [RznSoc], [MntNeto], [TasaImp], [IVA], [MntTotal]. */
function buildDetalleGuia(d: LibroGuiaDetalle): string {
  const parts = [el("Folio", d.folio)];
  if (d.anulado !== undefined) parts.push(el("Anulado", d.anulado));
  if (d.tpoOper !== undefined) parts.push(el("TpoOper", d.tpoOper));
  if (d.fecha) parts.push(el("FchDoc", d.fecha));
  if (d.rut) parts.push(el("RUTDoc", d.rut));
  if (d.razonSocial) parts.push(el("RznSoc", d.razonSocial.slice(0, 50)));
  if (d.montoNeto !== undefined && d.montoNeto > 0) parts.push(el("MntNeto", d.montoNeto));
  if (d.tasaIva !== undefined) parts.push(el("TasaImp", d.tasaIva));
  if (d.iva !== undefined && d.iva > 0) parts.push(el("IVA", d.iva));
  if (d.montoTotal !== undefined && d.montoTotal > 0) parts.push(el("MntTotal", d.montoTotal));
  return `<Detalle>${parts.join("")}</Detalle>`;
}

/**
 * Arma y FIRMA el Libro de Guías de Despacho. La firma cubre el `EnvioLibro`
 * (XMLDSig, C14N real). Pretty + tripwire 4096 (gateway legacy line-based).
 */
export function buildSignedLibroGuia(
  input: LibroGuiaInput,
  pfxBytes: Uint8Array,
  password: string,
): BuildLibroResult {
  if (!/^[A-Za-z_][\w.-]*$/.test(input.envioId)) {
    throw new Error(`buildSignedLibroGuia: envioId inválido como xs:ID: "${input.envioId}"`);
  }
  if (input.detalles.length === 0) throw new Error("buildSignedLibroGuia: sin detalle");

  const c = input;
  const caratula = `<Caratula>` +
    el("RutEmisorLibro", c.rutEmisorLibro) +
    el("RutEnvia", c.rutEnvia) +
    el("PeriodoTributario", c.periodoTributario) +
    el("FchResol", c.fchResol) +
    el("NroResol", c.nroResol) +
    el("TipoLibro", "ESPECIAL") +
    el("TipoEnvio", "TOTAL") +
    el("FolioNotificacion", c.folioNotificacion) +
    `</Caratula>`;

  const resumen = buildResumen(c.detalles);
  const detalle = c.detalles.map(buildDetalleGuia).join("");
  // TmstFirma (xs:dateTime) OBLIGATORIO, tras el Detalle (verificado vs LibroGuia_v10.xsd).
  const tmstFirma = el("TmstFirma", c.tmstFirma ?? `${c.periodoTributario}-01T12:00:00`);

  const envioLibro =
    (`<EnvioLibro ID="${input.envioId}">${caratula}${resumen}${detalle}${tmstFirma}</EnvioLibro>`)
      .replace(/></g, ">\r\n<");

  const unsigned = `<?xml version="1.0" encoding="ISO-8859-1"?>\r\n` +
    `<LibroGuia xmlns="${SII_NS}" xmlns:xsi="${XSI_NS}" ` +
    `xsi:schemaLocation="${SII_NS} LibroGuia_v10.xsd" version="1.0">\r\n` +
    `${envioLibro}\r\n</LibroGuia>`;

  const xml = signSiiXml({
    xml: unsigned,
    signedElementTag: "EnvioLibro",
    signedElementId: input.envioId,
    signedElementNs: SII_NS,
    pfxBytes,
    password,
  });

  const longLine = xml.split(/\r?\n/).find((l) => l.length > 4000);
  if (longLine) {
    throw new Error(`buildSignedLibroGuia: línea de ${longLine.length} chars supera el tope SII (4096)`);
  }

  return { xml, bytes: encodeLatin1(xml) };
}
