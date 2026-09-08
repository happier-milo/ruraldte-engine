// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Arma el XML `<ConsumoFolios>` (RCOF / RVD) sin firma y deriva sus `Resumen`
 * desde los folios emitidos y anulados del período (tipos 39, 41 y 61), en pesos
 * CLP enteros.
 *
 * El SII exige este reporte solo para CERTIFICAR boleta electrónica: en producción
 * la boleta ya se reporta en tiempo real (Res. Ex. SII N° 53/2022). El módulo es
 * puro —sin I/O, sin certificado—, así que la firma XMLDSig la pone después
 * `signConsumoFolios` de `@ruraldte/engine/firma`, usando el `documentId` que
 * devuelve el builder como `Reference URI="#…"`. El XML sale en forma PRETTY
 * (declaración ISO-8859-1 en su propia línea y CRLF en cada frontera de tags)
 * porque el gateway legacy del SII es line-based con tope ~4096 chars por línea:
 * no lo re-indentes ni lo vuelvas a serializar, la firma se computa sobre esa
 * forma exacta. `buildConsumoFoliosXml` valida solo la coherencia de folios (1 a 3
 * resúmenes, `FoliosUtilizados` = emitidos + anulados, y la suma de
 * `RangoUtilizados` = `FoliosEmitidos`) y lanza `Error`; no valida contra el XSD ni
 * revisa RUT, fechas ni montos. Ojo: `foliosAnulados` es la anulación de folios del
 * SII, NO las notas de crédito.
 *
 * @example
 * ```ts
 * import { buildConsumoFoliosXml, buildResumenes } from "@ruraldte/engine/consumo-folios";
 *
 * const resumenes = buildResumenes([
 *   { tipoDocumento: 39, folio: 1, mntNeto: 1000, mntIva: 190, mntTotal: 1190 },
 *   { tipoDocumento: 39, folio: 2, anulado: true, mntTotal: 0 },
 * ]);
 *
 * const { xml, documentId } = buildConsumoFoliosXml({
 *   caratula: {
 *     rutEmisor: "76543210-K", rutEnvia: "22222222-2",
 *     fchResol: "2026-06-06", nroResol: 0,
 *     fchInicio: "2026-06-06", fchFinal: "2026-06-06",
 *     secEnvio: 1, tmstFirmaEnv: "2026-06-06T12:00:00",
 *   },
 *   resumenes,
 * });
 * // documentId === "CF_76543210-K_20260606_1"; `xml` todavía va SIN firma.
 * ```
 *
 * @module
 */
// ============================================================================
// Consumo de Folios (RCOF / RVD) — generador del XML <ConsumoFolios>.
// ============================================================================
//
// El SII exige el "Reporte de Consumo de Folios" SOLO para CERTIFICAR boleta
// electrónica (Res. Ex. SII N° 53/2022: en producción ya NO se envía — la
// boleta se reporta en tiempo real). Como el oráculo de calibración no expone el RCOF por API,
// lo generamos y firmamos nosotros (decisión founder 2026-06-06).
//
// Este módulo es PURO (sin I/O, sin cert): arma el XML sin firma. La firma
// XMLDSig la agrega `xml-signature.ts`. Reusable por-RUT (nuestra SpA + cada
// APR cliente).
//
// Estructura (verificada contra el XSD oficial ConsumoFolio_v10.xsd,
// ns http://www.sii.cl/SiiDte):
//
//   <ConsumoFolios version="1.0" xmlns="http://www.sii.cl/SiiDte">
//     <DocumentoConsumoFolios ID="...">
//       <Caratula version="1.0">
//         RutEmisor, RutEnvia, FchResol, NroResol, FchInicio, FchFinal,
//         [Correlativo], SecEnvio, TmstFirmaEnv
//       </Caratula>
//       <Resumen>   (1..3, uno por TipoDocumento)
//         TipoDocumento, [MntNeto], [MntIva], [TasaIVA], [MntExento], MntTotal,
//         FoliosEmitidos, FoliosAnulados, FoliosUtilizados,
//         RangoUtilizados*(Inicial, Final), RangoAnulados*(Inicial, [Final])
//       </Resumen>
//       <!-- <Signature> la inserta xml-signature.ts -->
//     </DocumentoConsumoFolios>
//   </ConsumoFolios>
//
// Montos: pesos CLP enteros (convención del proyecto, sin centavos).
// El XML se emite COMPACTO (sin whitespace entre tags) para que la
// canonicalización C14N de la firma sea robusta — ver xml-signature.ts.
// ============================================================================

/** Tipos de documento que admite el RCOF (XSD TipoConsumoType). */
export type ConsumoTipoDocumento = 39 | 41 | 61;

/** Rango contiguo de folios [inicial, final]. */
export type RangoFolios = { inicial: number; final: number };

/** Resumen de un tipo de documento dentro del período. */
export type ResumenConsumo = {
  tipoDocumento: ConsumoTipoDocumento;
  /** Neto afecto, pesos enteros. 0/omitido para boleta exenta 41. */
  mntNeto?: number;
  /** IVA, pesos enteros. 0/omitido para boleta exenta 41. */
  mntIva?: number;
  /** Tasa IVA, ej. 19. Omitible. */
  tasaIva?: number;
  /** Exento, pesos enteros. >0 para boleta exenta 41. */
  mntExento?: number;
  /** Total del período para este tipo, pesos enteros. */
  mntTotal: number;
  /** Cantidad de documentos emitidos. */
  foliosEmitidos: number;
  /** Folios anulados por la opción de anulación de folios (NO por Nota de Crédito). */
  foliosAnulados: number;
  /** = foliosEmitidos + foliosAnulados. */
  foliosUtilizados: number;
  /** Rangos de folios utilizados (emitidos). */
  rangoUtilizados: RangoFolios[];
  /** Rangos de folios anulados (opcional). */
  rangoAnulados?: RangoFolios[];
};

/** Carátula del RCOF. */
export type ConsumoFoliosCaratula = {
  /** RUT emisor con guión: "78416626-0". */
  rutEmisor: string;
  /** RUT de quien firma/envía (rep legal autorizado). Debe = RUT del cert firmante. */
  rutEnvia: string;
  /** Fecha de la ResEx SII que autoriza a emitir DTE (AAAA-MM-DD). En cert suele ir 0/genérica. */
  fchResol: string;
  /** Número de la ResEx (en certificación = 0). */
  nroResol: number;
  /** Primer día del período (AAAA-MM-DD). */
  fchInicio: string;
  /** Último día del período (AAAA-MM-DD). Para envío diario = fchInicio. */
  fchFinal: string;
  /** Secuencia de envío: 1 la primera vez, +1 por reenvío del mismo período. */
  secEnvio: number;
  /** Timestamp de firma (AAAA-MM-DDTHH:MI:SS). */
  tmstFirmaEnv: string;
  /** Correlativo opcional (max 3 dígitos). */
  correlativo?: number;
};

/**
 * Entrada de `buildConsumoFoliosXml`: la carátula del período más sus resúmenes.
 * Si omites `documentId`, se deriva como `CF_<rutEmisor sin puntos ni espacios>_<fchInicio
 * sin guiones>_<secEnvio>` (ej. `CF_76543210-K_20260606_1`).
 */
export type ConsumoFoliosInput = {
  caratula: ConsumoFoliosCaratula;
  /** 1 a 3 resúmenes, uno por tipo de documento. */
  resumenes: ResumenConsumo[];
  /** Valor del atributo ID del DocumentoConsumoFolios. Si se omite, se deriva. */
  documentId?: string;
};

/**
 * Lo que devuelve `buildConsumoFoliosXml`: el XML todavía sin firma y el ID que la
 * firma referencia como `URI="#…"`. Entrega el `xml` tal cual al firmador —viene en
 * forma pretty (declaración en su propia línea y CRLF en cada frontera de tags) y el
 * digest se computa sobre esos bytes, así que reindentarlo o re-serializarlo antes o
 * después de firmar rompe la firma.
 */
export type BuildConsumoFoliosResult = {
  /** XML sin firma (root <ConsumoFolios>…</ConsumoFolios>). */
  xml: string;
  /** ID del DocumentoConsumoFolios (para la Reference URI="#id" de la firma). */
  documentId: string;
};

/** Registro de una boleta emitida, para derivar los resúmenes. */
export type EmittedBoletaRecord = {
  tipoDocumento: ConsumoTipoDocumento;
  folio: number;
  /** true si el folio fue anulado por la opción de anulación (no por NC). */
  anulado?: boolean;
  /** Montos en pesos enteros. */
  mntNeto?: number;
  mntIva?: number;
  mntExento?: number;
  mntTotal: number;
};

// ---------- XML helpers ------------------------------------------------------

/** Escapa texto para contenido de elemento (C14N: &, <, >, #xD). */
function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#xD;");
}

/** Escapa valor de atributo (C14N: &, <, ", #x9, #xA, #xD). */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#x9;")
    .replace(/\n/g, "&#xA;")
    .replace(/\r/g, "&#xD;");
}

function el(tag: string, value: string | number): string {
  return `<${tag}>${escapeText(String(value))}</${tag}>`;
}

/** Pesos enteros → string sin decimales. */
function money(value: number): string {
  return String(Math.round(value));
}

// ---------- Derivación de resúmenes -----------------------------------------

/**
 * Comprime una lista de folios en rangos contiguos ordenados.
 * Ej: [1,2,3,5,6,10] → [{1,3},{5,6},{10,10}].
 */
export function foliosToRangos(folios: number[]): RangoFolios[] {
  const sorted = [...new Set(folios)].sort((a, b) => a - b);
  const rangos: RangoFolios[] = [];
  for (const f of sorted) {
    const last = rangos[rangos.length - 1];
    if (last && f === last.final + 1) {
      last.final = f;
    } else {
      rangos.push({ inicial: f, final: f });
    }
  }
  return rangos;
}

/**
 * Deriva los `Resumen` (1 por tipo) desde los registros de boletas emitidas.
 * Suma montos por tipo, cuenta folios y comprime rangos.
 *
 * Convención boleta:
 *   - 39 (afecta): mntNeto/mntIva > 0, mntExento omitido.
 *   - 41 (exenta): mntExento > 0, mntNeto/mntIva = 0 (omitidos).
 */
export function buildResumenes(
  records: EmittedBoletaRecord[],
  opts?: { tasaIva?: number },
): ResumenConsumo[] {
  const byTipo = new Map<ConsumoTipoDocumento, EmittedBoletaRecord[]>();
  for (const r of records) {
    const arr = byTipo.get(r.tipoDocumento) ?? [];
    arr.push(r);
    byTipo.set(r.tipoDocumento, arr);
  }

  const resumenes: ResumenConsumo[] = [];
  // Orden estable por tipo de documento (39, 41, 61).
  for (const tipo of [39, 41, 61] as ConsumoTipoDocumento[]) {
    const recs = byTipo.get(tipo);
    if (!recs || recs.length === 0) continue;

    const emitidos = recs.filter((r) => !r.anulado);
    const anulados = recs.filter((r) => r.anulado);

    const sum = (key: keyof EmittedBoletaRecord) =>
      emitidos.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);

    const mntNeto = sum("mntNeto");
    const mntIva = sum("mntIva");
    const mntExento = sum("mntExento");
    const mntTotal = sum("mntTotal");

    const resumen: ResumenConsumo = {
      tipoDocumento: tipo,
      mntTotal,
      foliosEmitidos: emitidos.length,
      foliosAnulados: anulados.length,
      foliosUtilizados: emitidos.length + anulados.length,
      rangoUtilizados: foliosToRangos(emitidos.map((r) => r.folio)),
    };
    if (mntNeto > 0) resumen.mntNeto = mntNeto;
    if (mntIva > 0) {
      resumen.mntIva = mntIva;
      resumen.tasaIva = opts?.tasaIva ?? 19;
    }
    if (mntExento > 0) resumen.mntExento = mntExento;
    if (anulados.length > 0) {
      resumen.rangoAnulados = foliosToRangos(anulados.map((r) => r.folio));
    }
    resumenes.push(resumen);
  }

  return resumenes;
}

// ---------- Builder del XML --------------------------------------------------

function buildResumenXml(r: ResumenConsumo): string {
  const parts: string[] = [];
  parts.push(el("TipoDocumento", r.tipoDocumento));
  if (r.mntNeto !== undefined && r.mntNeto !== 0) parts.push(el("MntNeto", money(r.mntNeto)));
  if (r.mntIva !== undefined && r.mntIva !== 0) parts.push(el("MntIva", money(r.mntIva)));
  if (r.tasaIva !== undefined) parts.push(el("TasaIVA", String(r.tasaIva)));
  if (r.mntExento !== undefined && r.mntExento !== 0) parts.push(el("MntExento", money(r.mntExento)));
  parts.push(el("MntTotal", money(r.mntTotal)));
  parts.push(el("FoliosEmitidos", r.foliosEmitidos));
  parts.push(el("FoliosAnulados", r.foliosAnulados));
  parts.push(el("FoliosUtilizados", r.foliosUtilizados));
  for (const rango of r.rangoUtilizados) {
    parts.push(
      `<RangoUtilizados>${el("Inicial", rango.inicial)}${el("Final", rango.final)}</RangoUtilizados>`,
    );
  }
  for (const rango of r.rangoAnulados ?? []) {
    // Final es opcional para folio individual; lo omitimos si inicial === final.
    const final = rango.final !== rango.inicial ? el("Final", rango.final) : "";
    parts.push(
      `<RangoAnulados>${el("Inicial", rango.inicial)}${final}</RangoAnulados>`,
    );
  }
  return `<Resumen>${parts.join("")}</Resumen>`;
}

function buildCaratulaXml(c: ConsumoFoliosCaratula): string {
  const parts: string[] = [];
  parts.push(el("RutEmisor", c.rutEmisor));
  parts.push(el("RutEnvia", c.rutEnvia));
  parts.push(el("FchResol", c.fchResol));
  parts.push(el("NroResol", c.nroResol));
  parts.push(el("FchInicio", c.fchInicio));
  parts.push(el("FchFinal", c.fchFinal));
  if (c.correlativo !== undefined) parts.push(el("Correlativo", c.correlativo));
  parts.push(el("SecEnvio", c.secEnvio));
  parts.push(el("TmstFirmaEnv", c.tmstFirmaEnv));
  return `<Caratula version="1.0">${parts.join("")}</Caratula>`;
}

function deriveDocumentId(input: ConsumoFoliosInput): string {
  if (input.documentId) return input.documentId;
  const rut = input.caratula.rutEmisor.replace(/[.\s]/g, "");
  return `CF_${rut}_${input.caratula.fchInicio.replace(/-/g, "")}_${input.caratula.secEnvio}`;
}

/**
 * Valida invariantes básicas y arma el XML sin firma.
 * Lanza Error con mensaje claro si algo no cuadra (mejor fallar acá que en el SII).
 */
export function buildConsumoFoliosXml(
  input: ConsumoFoliosInput,
): BuildConsumoFoliosResult {
  if (input.resumenes.length < 1 || input.resumenes.length > 3) {
    throw new Error(
      `ConsumoFolios: se requieren 1 a 3 resúmenes, llegaron ${input.resumenes.length}`,
    );
  }
  for (const r of input.resumenes) {
    if (r.foliosUtilizados !== r.foliosEmitidos + r.foliosAnulados) {
      throw new Error(
        `ConsumoFolios tipo ${r.tipoDocumento}: FoliosUtilizados (${r.foliosUtilizados}) ` +
          `debe = FoliosEmitidos (${r.foliosEmitidos}) + FoliosAnulados (${r.foliosAnulados})`,
      );
    }
    const totalRangoUtil = r.rangoUtilizados.reduce(
      (acc, x) => acc + (x.final - x.inicial + 1),
      0,
    );
    if (totalRangoUtil !== r.foliosEmitidos) {
      throw new Error(
        `ConsumoFolios tipo ${r.tipoDocumento}: la suma de RangoUtilizados (${totalRangoUtil}) ` +
          `debe = FoliosEmitidos (${r.foliosEmitidos})`,
      );
    }
  }

  const documentId = deriveDocumentId(input);
  const caratula = buildCaratulaXml(input.caratula);
  const resumenes = input.resumenes.map(buildResumenXml).join("");

  // Forma física para el gateway legacy del SII (maullin/palena DTEUpload — el
  // canal del RVD/RCOF según la doc oficial de la API): es un parser LINE-BASED
  // con tope ~4096 chars/línea. El RCOF compacto en UNA línea (declaración
  // pegada al root) rebota "SCH-00001: Invalid Schema Name" (verificado VIVO
  // 2026-06-12). FIX: misma forma del sobre EnvioBOLETA que ese upload SÍ
  // acepta — declaración en su propia línea + CRLF entre tags (pretty). El
  // xsi:schemaLocation va igual (los XML de otras implementaciones que el SII acepta lo llevan).
  const compact =
    `<?xml version="1.0" encoding="ISO-8859-1"?>` +
    `<ConsumoFolios xmlns="http://www.sii.cl/SiiDte" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xsi:schemaLocation="http://www.sii.cl/SiiDte ConsumoFolio_v10.xsd" ` +
    `version="1.0">` +
    `<DocumentoConsumoFolios ID="${escapeAttr(documentId)}">` +
    caratula +
    resumenes +
    `</DocumentoConsumoFolios>` +
    `</ConsumoFolios>`;
  // Pretty CRLF en cada frontera de tags (los textos de los elementos no
  // contienen '<'/'>' — montos/fechas/RUTs escapados). La firma se computa
  // DESPUÉS sobre esta forma (firmar-lo-que-se-serializa, C14N en contexto).
  const xml = compact.replace(/></g, ">\r\n<");

  return { xml, documentId };
}
