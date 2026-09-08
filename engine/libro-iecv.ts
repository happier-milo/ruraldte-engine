// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Arma y firma el Libro de Compras y Ventas del SII (IEC/IEV): el sobre `<LibroCompraVenta>`
 * del schema `LibroCV_v10.xsd`, con el `EnvioLibro` firmado XMLDSig.
 *
 * Ventas y compras comparten sobre: cambian `tipoOperacion` y `folioNotificacion` (1 ventas /
 * 2 compras), la carátula sale fija en ESPECIAL/TOTAL y el resumen por tipo se totaliza desde
 * `detalles` — pero acá nadie valida el cuadre de cada línea ni contra el XSD: los montos entran
 * ya cuadrados. `ivaRetTotal` es campo del libro de VENTAS y nada te impide ponerlo en uno de
 * COMPRAS: ahí la retención total de una 45/46 va en `otrosImp` con `codImp: 15`, o el SII repara
 * el libro. Devuelve el `xml` (string con declaración ISO-8859-1) más los `bytes` de transmisión
 * ya codificados en iso-8859-1; el texto no se sanea acá, así que un carácter fuera de ese set
 * hace lanzar, igual que una línea sobre ~4 KB (tope line-based del gateway legacy).
 *
 * @example
 * ```ts
 * import { buildSignedLibroIecv, type LibroIecvInput } from "@ruraldte/engine/libro-iecv";
 *
 * const libro: LibroIecvInput = {
 *   tipoOperacion: "VENTA",
 *   rutEmisorLibro: "76543210-K", rutEnvia: "22222222-2",
 *   periodoTributario: "2026-06", fchResol: "2026-06-08", nroResol: 0,
 *   folioNotificacion: 1, envioId: "IEV202606",
 *   detalles: [{
 *     tipoDoc: 33, folio: 1, fecha: "2026-06-14", rut: "77777777-7",
 *     razonSocial: "Cliente Ltda", tasaIva: 19,
 *     montoNeto: 100000, montoIva: 19000, montoTotal: 119000,
 *   }],
 * };
 *
 * // `bytes` es lo que se sube al SII; `xml` sirve para inspeccionar o archivar.
 * const { xml, bytes } = buildSignedLibroIecv(libro, pfxBytes, pfxPassword);
 * ```
 *
 * @module
 */
// ============================================================================
// libro-iecv.ts — Información Electrónica de Ventas/Compras (IEV/IEC) firmada.
// ============================================================================
//
// La certificación de FACTURA exige, además de los DTE, enviar los Libros
// electrónicos (manual_certificacion.pdf §1; inst_set_pruebas.pdf §III-IV):
//   - IEV (Libro de Ventas): facturas + NC + ND del set básico/exento.
//   - IEC (Libro de Compras): los documentos del Set de Libro de Compras.
//
// Ambos son el mismo sobre `<LibroCompraVenta>` (schema LibroCV_v10.xsd), con
// `EnvioLibro` firmado XMLDSig. Difieren en `TipoOperacion` (VENTA/COMPRA) y el
// `FolioNotificacion` (1 ventas / 2 compras). Carátula ESPECIAL + envío TOTAL.
//
// Estructura calibrada contra el oráculo `~/Documents/SII Dev/LCVS-ejemplo.xml`
// y el XSD `schema_iecv/LibroCV_v10.xsd`:
//
//   <LibroCompraVenta xmlns=SiiDte xmlns:xsi schemaLocation="… LibroCV_v10.xsd">
//     <EnvioLibro ID="…">
//       <Caratula>RutEmisorLibro,RutEnvia,PeriodoTributario,FchResol,NroResol,
//                 TipoOperacion,TipoLibro,TipoEnvio,FolioNotificacion</Caratula>
//       <ResumenPeriodo><TotalesPeriodo>…por tipo…</TotalesPeriodo>+</ResumenPeriodo>
//       <Detalle>…por documento…</Detalle>*
//     </EnvioLibro>
//     <Signature/>   ← hermana de EnvioLibro (signSiiXml, transform enveloped)
//   </LibroCompraVenta>
//
// Se emite PRETTY (CRLF entre tags) por la regla line-based del gateway legacy
// (DTEUpload, ~4096/línea) — igual que el sobre EnvioDTE. La firma cubre el
// EnvioLibro en su contexto (C14N real, "firmar lo que se serializa").
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

/** Una línea de detalle del libro (un documento). */
export type LibroDetalle = {
  /** Tipo de documento (33/34/56/61/…). */
  tipoDoc: number;
  /** Folio del documento (NroDoc). */
  folio: number;
  /** Fecha del documento AAAA-MM-DD (FchDoc). */
  fecha: string;
  /** RUT de la contraparte: receptor en ventas, emisor del doc en compras (RUTDoc). */
  rut: string;
  /** Razón social de la contraparte (RznSoc). */
  razonSocial?: string;
  /** Tasa de IVA (TasaImp). Default 19 si hay neto. */
  tasaIva?: number;
  /** Monto exento (MntExe). */
  montoExento?: number;
  /** Monto neto afecto (MntNeto). */
  montoNeto?: number;
  /** Monto IVA (MntIVA). */
  montoIva?: number;
  /** IVA de uso común (IVAUsoComun) — IEC. El IVA COMPLETO del doc; el crédito recuperable
   *  se deriva en el resumen vía FctProp (TotCredIVAUsoComun). */
  ivaUsoComun?: number;
  /** IVA NO recuperable (IVANoRec) — IEC, por código (CodIVANoRec). Ej. entrega gratuita
   *  del proveedor → cod 4. Va FUERA de MntIVA (que es solo IVA recuperable en compras). */
  ivaNoRec?: { cod: number; monto: number }[];
  /** Otros impuestos/retenciones (OtrosImp) por código — IEC. La retención total de IVA
   *  de una factura de compra se informa acá con CodImp=15 (NO con IVARetTotal, que es del
   *  libro de VENTAS). */
  otrosImp?: { codImp: number; tasaImp?: number; mntImp: number }[];
  /** IVA retenido total (IVARetTotal) — campo del libro de VENTAS (LV) para ventas con retención.
   *  ⚠️ NO usar en el libro de COMPRAS: la retención total de IVA de una Factura de Compra recibida
   *  (cod 45/46) se informa en COMPRAS con OtrosImp CodImp=15 (ver ejemplos_libro_compras.pdf §2.1 +
   *  cod_otros_imp_retenc.pdf). Usar IVARetTotal en COMPRAS da el reparo SII "No Informa Adecuadamente
   *  IVA Retenido Total" (verificado en vivo, set 4907372, 2026-06-18). */
  ivaRetTotal?: number;
  /** true = factura de compra (IndFactCompra=1). */
  facturaCompra?: boolean;
  /** true = documento anulado (Anulado="A") — p.ej. NC que anula. */
  anulado?: boolean;
  /** Monto total (MntTotal). */
  montoTotal: number;
};

/**
 * Carátula, detalle documento a documento y datos de envío de un Libro de Compras y Ventas
 * (IEV/IEC) de un período. El `ResumenPeriodo` no se pasa: se totaliza por tipo de documento
 * (orden ascendente) desde `detalles`, y acá no se valida el cuadre ni que cada línea caiga
 * dentro de `periodoTributario`; la carátula sale fija en ESPECIAL/TOTAL.
 */
export type LibroIecvInput = {
  /** "VENTA" = IEV · "COMPRA" = IEC. */
  tipoOperacion: "VENTA" | "COMPRA";
  /** RUT del contribuyente dueño del libro. */
  rutEmisorLibro: string;
  /** RUT del firmante autorizado. */
  rutEnvia: string;
  /** Período tributario AAAA-MM (todos los docs del mismo período). */
  periodoTributario: string;
  /** Fecha de resolución de la empresa en cert (AAAA-MM-DD). */
  fchResol: string;
  /** Número de resolución de la empresa en cert. */
  nroResol: number;
  /** Folio de notificación: 1 (ventas) / 2 (compras) en el set. */
  folioNotificacion: number;
  /** Valor del atributo ID del EnvioLibro (xs:ID; empieza con letra/_). */
  envioId: string;
  /** Detalle por documento. */
  detalles: LibroDetalle[];
  /** Factor de proporcionalidad del IVA de uso común (FctProp), ej. 0.60. */
  factorProporcionalidad?: number;
  /** Timestamp de firma (TmstFirma, AAAA-MM-DDThh:mm:ss). Default: 1° del período. */
  tmstFirma?: string;
};

/**
 * El libro firmado en sus dos formas. Al SII se suben los `bytes` (ya codificados en
 * iso-8859-1); `xml` sirve para inspeccionar o archivar, y guardarlo como UTF-8 contradice
 * su propia declaración `ISO-8859-1`.
 */
export type BuildLibroResult = {
  /** Libro firmado (string Unicode, declaración iso-8859-1). */
  xml: string;
  /** Bytes de transmisión (iso-8859-1). */
  bytes: Uint8Array;
};

type Totales = {
  tipoDoc: number;
  totDoc: number;
  totExe: number;
  totNeto: number;
  totIva: number;
  totIvaUsoComun: number;
  totIvaRetTotal: number;
  /** Conteo de operaciones con IVA retenido total (TotOpIVARetTotal). */
  totOpIvaRetTotal: number;
  /** IVA no recuperable por código: cod → { op (conteo), monto }. */
  totIvaNoRec: Map<number, { op: number; monto: number }>;
  /** Otros impuestos por código: codImp → monto total. */
  totOtrosImp: Map<number, number>;
  totTotal: number;
  tieneUsoComun: boolean;
};

/** Agrupa el detalle por tipo de documento y totaliza (orden ascendente). */
function resumir(detalles: LibroDetalle[]): Totales[] {
  const byTipo = new Map<number, Totales>();
  for (const d of detalles) {
    const t = byTipo.get(d.tipoDoc) ?? {
      tipoDoc: d.tipoDoc,
      totDoc: 0,
      totExe: 0,
      totNeto: 0,
      totIva: 0,
      totIvaUsoComun: 0,
      totIvaRetTotal: 0,
      totOpIvaRetTotal: 0,
      totIvaNoRec: new Map<number, { op: number; monto: number }>(),
      totOtrosImp: new Map<number, number>(),
      totTotal: 0,
      tieneUsoComun: false,
    };
    t.totDoc += 1;
    t.totExe += d.montoExento ?? 0;
    t.totNeto += d.montoNeto ?? 0;
    t.totIva += d.montoIva ?? 0;
    t.totIvaUsoComun += d.ivaUsoComun ?? 0;
    t.totIvaRetTotal += d.ivaRetTotal ?? 0;
    if ((d.ivaRetTotal ?? 0) > 0) t.totOpIvaRetTotal += 1;
    for (const nr of d.ivaNoRec ?? []) {
      const prev = t.totIvaNoRec.get(nr.cod) ?? { op: 0, monto: 0 };
      t.totIvaNoRec.set(nr.cod, { op: prev.op + 1, monto: prev.monto + nr.monto });
    }
    for (const oi of d.otrosImp ?? []) {
      t.totOtrosImp.set(oi.codImp, (t.totOtrosImp.get(oi.codImp) ?? 0) + oi.mntImp);
    }
    t.totTotal += d.montoTotal;
    if ((d.ivaUsoComun ?? 0) > 0) t.tieneUsoComun = true;
    byTipo.set(d.tipoDoc, t);
  }
  return [...byTipo.values()].sort((a, b) => a.tipoDoc - b.tipoDoc);
}

/**
 * TotalesPeriodo. Orden XSD (LibroCV_v10): TpoDoc, TotDoc, [TotAnulado], [TotOpExe],
 * TotMntExe, TotMntNeto, [TotOpIVARec], TotMntIVA, …, [TotIVAUsoComun], [FctProp], …,
 * TotMntTotal. **TotMntExe/TotMntNeto/TotMntIVA son OBLIGATORIOS** (minOccurs=1) →
 * se emiten siempre, aunque sean 0 (verificado vs XSD con xmllint).
 */
function buildTotalesPeriodo(t: Totales, factorProp?: number): string {
  const parts = [
    el("TpoDoc", t.tipoDoc),
    el("TotDoc", t.totDoc),
    el("TotMntExe", t.totExe),
    el("TotMntNeto", t.totNeto),
    el("TotMntIVA", t.totIva),
  ];
  // TotIVANoRec (IVA no recuperable por código): tras TotMntIVA, antes de TotIVAUsoComun.
  // Cada uno: CodIVANoRec + TotOpIVANoRec (conteo) + TotMntIVANoRec.
  for (const [cod, v] of [...t.totIvaNoRec.entries()].sort((a, b) => a[0] - b[0])) {
    parts.push(`<TotIVANoRec>${el("CodIVANoRec", cod)}${el("TotOpIVANoRec", v.op)}${el("TotMntIVANoRec", v.monto)}</TotIVANoRec>`);
  }
  if (t.totIvaUsoComun > 0) parts.push(el("TotIVAUsoComun", t.totIvaUsoComun));
  if (t.tieneUsoComun && factorProp !== undefined) {
    parts.push(el("FctProp", factorProp));
    // TotCredIVAUsoComun = crédito recuperable = round(TotIVAUsoComun × FctProp). El SII
    // recalcula este crédito y lo compara → faltaba (reparo "El Crédito IVA Uso Común No Cuadra").
    parts.push(el("TotCredIVAUsoComun", Math.round(t.totIvaUsoComun * factorProp)));
  }
  // TotOtrosImp (otros impuestos/recargos por código): antes de TotMntTotal. La retención TOTAL de IVA
  // de Facturas de Compra recibidas (cambio de sujeto) SÍ va acá con CodImp=15 en el libro de COMPRAS
  // (ejemplos_libro_compras.pdf §2.1); TotIVARetTotal (abajo) es del libro de VENTAS.
  for (const [cod, monto] of [...t.totOtrosImp.entries()].sort((a, b) => a[0] - b[0])) {
    parts.push(`<TotOtrosImp>${el("CodImp", cod)}${el("TotMntImp", monto)}</TotOtrosImp>`);
  }
  // TotOpIVARetTotal + TotIVARetTotal: retención TOTAL de IVA en Facturas de Compra recibidas (cod
  // 45/46) — formato_iecv L653. TotOpIVARetTotal = conteo de operaciones; TotIVARetTotal = suma.
  if (t.totIvaRetTotal > 0) {
    parts.push(el("TotOpIVARetTotal", t.totOpIvaRetTotal));
    parts.push(el("TotIVARetTotal", t.totIvaRetTotal));
  }
  // TotMntTotal = Σ(MntTotal de detalle). El upload (cuadre LBR) EXIGE TotMntTotal = Σ MntTotal — restar
  // la retención acá da LRH "Libro Rechazado - Descuadrado" (probado en vivo 2026-06-18). La retención se
  // refleja porque cada MntTotal de detalle de una FC con retención total YA es neto (Neto+IVA−IVARetTotal).
  parts.push(el("TotMntTotal", t.totTotal));
  return `<TotalesPeriodo>${parts.join("")}</TotalesPeriodo>`;
}

/** Detalle (orden XSD): TpoDoc, [IndFactCompra], NroDoc, [Anulado], [TasaImp], [FchDoc], [RUTDoc], [RznSoc], [MntExe], [MntNeto], [MntIVA], [IVANoRec]*, [IVAUsoComun], [OtrosImp]*, [IVARetTotal(LV)], [MntTotal]. */
function buildDetalleLibro(d: LibroDetalle): string {
  const parts = [el("TpoDoc", d.tipoDoc)];
  if (d.facturaCompra) parts.push(el("IndFactCompra", 1));
  parts.push(el("NroDoc", d.folio));
  if (d.anulado) parts.push(el("Anulado", "A"));
  if (d.tasaIva !== undefined) parts.push(el("TasaImp", d.tasaIva));
  parts.push(el("FchDoc", d.fecha));
  parts.push(el("RUTDoc", d.rut));
  if (d.razonSocial) parts.push(el("RznSoc", d.razonSocial.slice(0, 50)));
  // El SII exige ≥1 de [MntExe MntNeto MntIVA] por detalle (LBR-3 "Falta [MntNeto
  // MntExe MntIVA]"). Un documento de monto 0 (NC/ND corrige-texto) no tiene ninguno
  // > 0 → se emite MntExe=0 para cumplir.
  const sinMonto = (d.montoExento ?? 0) <= 0 && (d.montoNeto ?? 0) <= 0 && (d.montoIva ?? 0) <= 0;
  if (d.montoExento !== undefined && d.montoExento > 0) parts.push(el("MntExe", d.montoExento));
  else if (sinMonto) parts.push(el("MntExe", 0));
  if (d.montoNeto !== undefined && d.montoNeto > 0) parts.push(el("MntNeto", d.montoNeto));
  if (d.montoIva !== undefined && d.montoIva > 0) parts.push(el("MntIVA", d.montoIva));
  // IVANoRec (IVA no recuperable, ej. entrega gratuita CodIVANoRec=4): tras MntIVA, antes de IVAUsoComun.
  for (const nr of d.ivaNoRec ?? []) {
    parts.push(`<IVANoRec>${el("CodIVANoRec", nr.cod)}${el("MntIVANoRec", nr.monto)}</IVANoRec>`);
  }
  if (d.ivaUsoComun !== undefined && d.ivaUsoComun > 0) parts.push(el("IVAUsoComun", d.ivaUsoComun));
  // OtrosImp (retención IVA total FC con CodImp=15, etc.): tras IVAUsoComun, antes de MntTotal.
  for (const oi of d.otrosImp ?? []) {
    parts.push(`<OtrosImp>${el("CodImp", oi.codImp)}${oi.tasaImp !== undefined ? el("TasaImp", oi.tasaImp) : ""}${el("MntImp", oi.mntImp)}</OtrosImp>`);
  }
  // IVARetTotal: SOLO libro de VENTAS (LV) — retención en ventas. En COMPRAS la retención total de una
  // FC 45/46 va en OtrosImp CodImp=15 (arriba), NO acá (verificado SOK set 4907372, 2026-06-18).
  if (d.ivaRetTotal !== undefined && d.ivaRetTotal > 0) parts.push(el("IVARetTotal", d.ivaRetTotal));
  parts.push(el("MntTotal", d.montoTotal));
  return `<Detalle>${parts.join("")}</Detalle>`;
}

/**
 * Arma y FIRMA el Libro IEV/IEC. Devuelve string Unicode (declaración iso-8859-1)
 * + bytes de transmisión. La firma cubre el `EnvioLibro` (XMLDSig, C14N real).
 */
export function buildSignedLibroIecv(
  input: LibroIecvInput,
  pfxBytes: Uint8Array,
  password: string,
): BuildLibroResult {
  if (!/^[A-Za-z_][\w.-]*$/.test(input.envioId)) {
    throw new Error(`buildSignedLibroIecv: envioId inválido como xs:ID: "${input.envioId}"`);
  }
  if (input.detalles.length === 0) throw new Error("buildSignedLibroIecv: sin detalle");

  const c = input;
  const caratula = `<Caratula>` +
    el("RutEmisorLibro", c.rutEmisorLibro) +
    el("RutEnvia", c.rutEnvia) +
    el("PeriodoTributario", c.periodoTributario) +
    el("FchResol", c.fchResol) +
    el("NroResol", c.nroResol) +
    el("TipoOperacion", c.tipoOperacion) +
    el("TipoLibro", "ESPECIAL") +
    el("TipoEnvio", "TOTAL") +
    el("FolioNotificacion", c.folioNotificacion) +
    `</Caratula>`;

  const resumen = `<ResumenPeriodo>` +
    resumir(c.detalles).map((t) => buildTotalesPeriodo(t, c.factorProporcionalidad)).join("") +
    `</ResumenPeriodo>`;

  const detalle = c.detalles.map(buildDetalleLibro).join("");

  // TmstFirma (xs:dateTime) es OBLIGATORIO en EnvioLibro, va tras el Detalle y antes
  // de la firma (verificado vs LibroCV_v10.xsd con xmllint).
  const tmstFirma = el("TmstFirma", c.tmstFirma ?? `${c.periodoTributario}-01T12:00:00`);

  // Compacto → pretty (CRLF entre tags) por la regla line-based del gateway.
  const envioLibro =
    (`<EnvioLibro ID="${input.envioId}">${caratula}${resumen}${detalle}${tmstFirma}</EnvioLibro>`)
      .replace(/></g, ">\r\n<");

  const unsigned = `<?xml version="1.0" encoding="ISO-8859-1"?>\r\n` +
    `<LibroCompraVenta xmlns="${SII_NS}" xmlns:xsi="${XSI_NS}" ` +
    `xsi:schemaLocation="${SII_NS} LibroCV_v10.xsd" version="1.0">\r\n` +
    `${envioLibro}\r\n</LibroCompraVenta>`;

  // Firma del EnvioLibro (XMLDSig enveloped, C14N real en contexto).
  const xml = signSiiXml({
    xml: unsigned,
    signedElementTag: "EnvioLibro",
    signedElementId: input.envioId,
    signedElementNs: SII_NS,
    pfxBytes,
    password,
  });

  // Tripwire 4096 (gateway legacy line-based).
  const longLine = xml.split(/\r?\n/).find((l) => l.length > 4000);
  if (longLine) {
    throw new Error(
      `buildSignedLibroIecv: línea de ${longLine.length} chars supera el tope SII (4096)`,
    );
  }

  return { xml, bytes: encodeLatin1(xml) };
}
