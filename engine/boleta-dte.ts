// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Renderiza y firma el `<DTE>` de una boleta electrónica chilena, tipo 39 (afecta) o 41
 * (exenta): Encabezado, Detalle, Referencia opcional, TED y bloque `<Signature>`.
 *
 * `buildBoletaDocumento` te devuelve el `<Documento>` compacto sin firmar más su ID (útil
 * si firmas en otro borde); `buildSignedBoletaDte` hace el render y la firma con el `.pfx`
 * en un paso, y el `<Signature>` XMLDSig queda dentro del `<DTE>` referenciando al
 * `<Documento>` por `URI="#ID"`. El módulo no calcula ni cuadra los totales: `totals` lo
 * pasas ya cuadrado y solo se omiten los componentes que no son > 0; de cada ítem deriva
 * `PrcItem = round(precio)` y `MontoItem = round(precio * cantidad)` — en boleta el
 * `precio` es BRUTO, con IVA incluido — y trunca EN SILENCIO los textos al largo del XSD
 * (razón social 100, giro 80, dirección 70, comuna 20, nombre del ítem 80). Dos trampas:
 * lanza si `items` viene vacío o si `documentId` no es un `xs:ID` válido (parte con letra
 * o `_`, nunca con dígito), y el RUT del receptor se normaliza en un solo punto para que
 * `<RUTRecep>` y el `<RR>` del TED queden idénticos — si difieren, el SII responde "Firma
 * TED no coincide". El string sale en Unicode con declaración `iso-8859-1`: los bytes que
 * se transmiten los produce `encodeLatin1` (`@ruraldte/engine/firma`) y el sobre
 * `EnvioBOLETA` lo arma `@ruraldte/engine/sobre-boleta`.
 *
 * @example
 * ```ts
 * import { buildSignedBoletaDte } from "@ruraldte/engine/boleta";
 *
 * const xml = buildSignedBoletaDte({
 *   tipoDte: 39,
 *   folio: 1,
 *   fechaEmision: "2026-06-08",
 *   indServicio: 3, // 3 = venta y servicios
 *   emisor: {
 *     rut: "76543210-K",
 *     razonSocial: "ACME SPA",
 *     giro: "SERVICIOS INFORMATICOS",
 *     dirOrigen: "Av. Portales 123",
 *     cmnaOrigen: "Quinta Normal",
 *   },
 *   receptor: { rut: "22222222-2", razonSocial: "Cliente Final" },
 *   items: [{ nombre: "Cambio de aceite", cantidad: 1, precio: 19900 }], // precio BRUTO
 *   totals: { neto: 16723, iva: 3177, exento: 0, total: 19900 },         // los calculas tú
 *   cafXml,
 *   tstedIso: "2026-06-08T18:24:11",
 *   tmstFirma: "2026-06-08T18:24:11",
 *   documentId: "F39T1", // xs:ID: parte con letra o "_"
 * }, pfxBytes, pfxPassword);
 * ```
 *
 * @module
 */
// ============================================================================
// boleta-dte.ts — render del <DTE><Documento> de boleta 39/41 (Plan B, Comp. A).
// ============================================================================
//
// Renderiza el cuerpo del DTE de boleta (Encabezado / Detalle / Totales /
// Referencia / TED / TmstFirma) calibrado contra la salida REAL del oráculo de calibración
// (oráculo aceptado por el SII). Estructura verificada del refDteXml capturado:
//
//   <DTE version="1.0">                         ← SIN xmlns (el oráculo de calibración lo omite)
//     <Documento ID="T_...">
//       <Encabezado>
//         <IdDoc><TipoDTE/><Folio/><FchEmis/></IdDoc>
//         <Emisor><RUTEmisor/><RznSocEmisor/><GiroEmisor/><DirOrigen/><CmnaOrigen/></Emisor>
//         <Receptor><RUTRecep/><RznSocRecep/></Receptor>
//         <Totales>                              ← 39: MntNeto+IVA+MntTotal · 41: MntExento+MntTotal
//       </Encabezado>
//       <Detalle>NroLinDet,NmbItem,QtyItem,UnmdItem,PrcItem,MontoItem</Detalle> (1..N)
//       <Referencia>NroLinRef,TpoDocRef,FolioRef,RazonRef</Referencia>
//       <TED version="1.0">…</TED>               ← timbre (boleta-ted.ts)
//       <TmstFirma/>
//     </Documento>
//     <!-- <Signature> la inserta xml-signature.ts (paso siguiente) -->
//   </DTE>
//
// DECISIÓN: el Documento se emite COMPACTO (sin whitespace entre tags). El DTE va
// firmado con XMLDSig (C14N) → el SII canonicaliza, así que byte-identidad NO es
// el criterio (además ID/TmstFirma/TSTED son timestamps → la firma jamás iguala a
// la del oráculo de calibración). El DD embebido va compacto y la FRMT firma el compacto (validado
// byte-a-byte vs el oráculo de calibración en boleta-ted.ts; el SII canonicaliza el DD igual).
//
// Montos: pesos CLP enteros (sin centavos).
// ENCODING: el XML final va en iso-8859-1 (paso de ensamblado/firma); acá se
// produce el string Unicode con los valores correctos (acentos incluidos).
// ============================================================================

import { buildTed, compactSiiDd } from "./boleta-ted.ts";
import { signBoletaDte } from "./xml-signature.ts";
import { sanitizeSiiText } from "./sii-text.ts";

/** Escapa texto para contenido de elemento XML. */
function escText(s: string): string {
  return sanitizeSiiText(s) // puntuación Unicode → Latin-1 (el DTE va en iso-8859-1)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
  return escText(s).replace(/"/g, "&quot;");
}
function el(tag: string, value: string | number): string {
  return `<${tag}>${escText(String(value))}</${tag}>`;
}
// Normaliza un RUT al formato canónico del SII (sin puntos, con guion, DV mayúscula):
// "76.123.456-k" → "76123456-K". El XSD de RUTRecep lo exige. Se aplica en UN punto
// (buildBoletaDocumento) para que el XML y el TED usen idéntico valor (evita "Firma TED
// no coincide"). Idempotente: normalizar dos veces da lo mismo.
function normRut(rut: string): string {
  const c = rut.replace(/[.\s-]/g, "").toUpperCase();
  return c.length < 2 ? c : `${c.slice(0, -1)}-${c.slice(-1)}`;
}

/**
 * Línea del `<Detalle>` de la boleta. De acá salen `PrcItem = round(precio)` y
 * `MontoItem = round(precio * cantidad)` —en boleta el precio va BRUTO, con IVA
 * incluido cuando la línea es afecta— y `nombre` se trunca a 80 caracteres sin avisar.
 */
export type BoletaDteItem = {
  nombre: string;
  cantidad: number;
  /** Precio unitario bruto (con IVA si afecta), pesos enteros. */
  precio: number;
  /** Unidad de medida; el oráculo de calibración emite "un" por defecto. */
  unidadMedida?: string;
  /** true = línea exenta (agrega IndExe=1). */
  exento?: boolean;
};

/**
 * Totales del `<Encabezado>`, en pesos enteros: los calculas y los cuadras tú, el motor
 * no los deriva de `items` ni los redondea. Solo se emiten los componentes > 0
 * (`MntNeto`, `MntExe`, `IVA`); `MntTotal` va siempre.
 */
export type BoletaDteTotals = {
  neto: number;
  iva: number;
  exento: number;
  total: number;
};

/**
 * Referencia opcional del documento; se emite como una sola línea `<Referencia>` con
 * `NroLinRef` 1, en el orden del XSD. `folioRef` solo aparece si además pasas
 * `tipoDocRef`, y los textos se truncan a 3 (`tipoDocRef`), 18 (`codRef`) y 90
 * (`razonRef`) caracteres.
 */
export type BoletaDteReferencia = {
  /**
   * Para el SET de certificación va `tipoDocRef="SET"` + `folioRef=<n° de caso>` +
   * `razonRef="CASO-N"` (instrucción SII: "SET" en el campo tipo de documento de
   * referencia; el SII casa cada CASO por TpoDocRef="SET"). `codRef` (1/2/3) es
   * para anular/corregir OTRO documento tributario, NO el set.
   */
  codRef?: string;
  razonRef?: string;
  tipoDocRef?: string;
  folioRef?: number | string;
};

/**
 * Entrada completa del render de una boleta 39/41: identificación, partes, líneas,
 * totales ya cuadrados y el material de timbre y firma (`cafXml`, `tstedIso`,
 * `tmstFirma`, `documentId`). `receptor.rut` se normaliza adentro (acepta puntos,
 * minúsculas o sin guion), pero `emisor.rut` NO: viaja tal cual a `<RUTEmisor>` y al
 * `<RE>` del TED, así que pásalo ya canónico, tipo `76543210-K`. Montos en pesos enteros.
 */
export type BoletaDteInput = {
  tipoDte: 39 | 41;
  folio: number;
  /** AAAA-MM-DD. */
  fechaEmision: string;
  /**
   * Indicador de servicio (OBLIGATORIO en boleta, Formato v4.2 §A campo 5):
   * 1=Serv.Periódicos · 2=Serv.Periódicos Domiciliarios (agua/luz APR; obliga
   * FchVenc+DirRecep) · 3=Venta y Servicios (set cert; admite RUT 66666666-6) ·
   * 4=Espectáculo por terceros.
   */
  indServicio: 1 | 2 | 3 | 4;
  /** AAAA-MM-DD. Obligatorio si indServicio=2 (devengo IVA al vencimiento). */
  fchVenc?: string;
  /** Servicios periódicos: inicio/fin del período facturado (AAAA-MM-DD). */
  periodoDesde?: string;
  periodoHasta?: string;
  emisor: {
    rut: string;
    razonSocial: string;
    giro: string;
    dirOrigen: string;
    cmnaOrigen: string;
  };
  receptor: {
    rut: string;
    razonSocial?: string;
    /** Código interno del cliente (medidor/parcela). Si rut="0" es obligatorio. */
    cdgIntRecep?: string;
    /** Dirección del servicio. Obligatoria si indServicio=1 o 2. */
    dirRecep?: string;
  };
  items: BoletaDteItem[];
  totals: BoletaDteTotals;
  /** Referencia (set de certificación). Opcional en producción. */
  referencia?: BoletaDteReferencia;
  /** CAF XML completo (para el TED). */
  cafXml: string;
  /** Timestamp del timbre, AAAA-MM-DDThh:mm:ss. */
  tstedIso: string;
  /** Timestamp de firma del DTE, AAAA-MM-DDThh:mm:ss (= tstedIso normalmente). */
  tmstFirma: string;
  /** Valor del atributo ID del <Documento> (Reference URI de la firma). */
  documentId: string;
};

/**
 * Lo que devuelve `buildBoletaDocumento`: el `<Documento>` compacto sin firmar y su ID.
 * Pásale los dos al firmador — el `documentId` es el que va en `URI="#id"` de la
 * `<Reference>` XMLDSig.
 */
export type BuildBoletaDocumentoResult = {
  /** <Documento ID="…">…</Documento> compacto, SIN firma. */
  documento: string;
  /** ID del Documento (para la Reference URI="#id" de la firma XMLDSig). */
  documentId: string;
};

function buildEncabezado(input: BoletaDteInput): string {
  const { emisor, receptor, totals } = input;
  // IdDoc orden XSD: TipoDTE, Folio, FchEmis, IndServicio(OBL), [PeriodoDesde],
  // [PeriodoHasta], [FchVenc].
  const idParts: string[] = [
    el("TipoDTE", input.tipoDte),
    el("Folio", input.folio),
    el("FchEmis", input.fechaEmision),
    el("IndServicio", input.indServicio),
  ];
  if (input.periodoDesde) idParts.push(el("PeriodoDesde", input.periodoDesde));
  if (input.periodoHasta) idParts.push(el("PeriodoHasta", input.periodoHasta));
  if (input.fchVenc) idParts.push(el("FchVenc", input.fchVenc));
  const idDoc = `<IdDoc>${idParts.join("")}</IdDoc>`;
  const emisorXml =
    `<Emisor>` +
    el("RUTEmisor", emisor.rut) +
    el("RznSocEmisor", emisor.razonSocial.slice(0, 100)) +
    el("GiroEmisor", emisor.giro.slice(0, 80)) +
    el("DirOrigen", emisor.dirOrigen.slice(0, 70)) +
    el("CmnaOrigen", emisor.cmnaOrigen.slice(0, 20)) +
    `</Emisor>`;
  // Receptor orden XSD: RUTRecep, [CdgIntRecep], [RznSocRecep], [DirRecep], …
  const recParts: string[] = [el("RUTRecep", receptor.rut)];
  if (receptor.cdgIntRecep) recParts.push(el("CdgIntRecep", receptor.cdgIntRecep.slice(0, 20)));
  if (receptor.razonSocial) recParts.push(el("RznSocRecep", receptor.razonSocial.slice(0, 100)));
  if (receptor.dirRecep) recParts.push(el("DirRecep", receptor.dirRecep.slice(0, 70)));
  const receptorXml = `<Receptor>${recParts.join("")}</Receptor>`;
  // Totales orden XSD: MntNeto, MntExe, IVA, MntTotal. Afecta (39)=Neto+IVA;
  // exenta (41)=MntExe. IVA es MntImpType (>0): se omite si 0 (no <IVA>0</IVA>).
  const totalesParts: string[] = [];
  if (totals.neto > 0) totalesParts.push(el("MntNeto", totals.neto));
  if (totals.exento > 0) totalesParts.push(el("MntExe", totals.exento));
  if (totals.iva > 0) totalesParts.push(el("IVA", totals.iva));
  totalesParts.push(el("MntTotal", totals.total));
  const totalesXml = `<Totales>${totalesParts.join("")}</Totales>`;
  return `<Encabezado>${idDoc}${emisorXml}${receptorXml}${totalesXml}</Encabezado>`;
}

function buildDetalle(item: BoletaDteItem, nroLinea: number): string {
  const parts: string[] = [];
  parts.push(el("NroLinDet", nroLinea));
  if (item.exento) parts.push(el("IndExe", 1));
  parts.push(el("NmbItem", item.nombre.slice(0, 80)));
  parts.push(el("QtyItem", item.cantidad));
  parts.push(el("UnmdItem", item.unidadMedida ?? "un"));
  parts.push(el("PrcItem", Math.round(item.precio)));
  parts.push(el("MontoItem", Math.round(item.precio * item.cantidad)));
  return `<Detalle>${parts.join("")}</Detalle>`;
}

function buildReferencia(ref: BoletaDteReferencia, nroLinea: number): string {
  // Orden XSD boleta: NroLinRef, [TpoDocRef], [FolioRef], [CodRef], [RazonRef].
  // El SET de certificación va en TpoDocRef="SET" + FolioRef=<n° de caso> +
  // RazonRef="CASO-N" (el SII casa cada CASO por TpoDocRef="SET"; verificado VIVO
  // 2026-06-12: ponerlo en CodRef rebota SRH "El Documento no esta en el envio").
  const parts: string[] = [el("NroLinRef", nroLinea)];
  if (ref.tipoDocRef) {
    parts.push(el("TpoDocRef", ref.tipoDocRef.slice(0, 3)));
    if (ref.folioRef !== undefined) parts.push(el("FolioRef", ref.folioRef));
  }
  if (ref.codRef) parts.push(el("CodRef", ref.codRef.slice(0, 18)));
  if (ref.razonRef) parts.push(el("RazonRef", ref.razonRef.slice(0, 90)));
  return `<Referencia>${parts.join("")}</Referencia>`;
}

/** TED con el DD COMPACTO embebido (la FRMT firma el compacto; el SII lo canonicaliza). */
function buildTedCompact(input: BoletaDteInput): string {
  const { dd, frmt } = buildTed({
    cafXml: input.cafXml,
    rutEmisor: input.emisor.rut,
    tipoDte: input.tipoDte,
    folio: input.folio,
    fechaEmision: input.fechaEmision,
    rutReceptor: input.receptor.rut,
    razonSocialReceptor: input.receptor.razonSocial,
    montoTotal: input.totals.total,
    item1: input.items[0]?.nombre ?? "",
    tstedIso: input.tstedIso,
  });
  return `<TED version="1.0">${compactSiiDd(dd)}<FRMT algoritmo="SHA1withRSA">${frmt}</FRMT></TED>`;
}

/**
 * Arma el `<Documento>` compacto sin firma. La firma XMLDSig (enveloped) la
 * agrega el ensamblador del DTE con `xml-signature.ts` (paso siguiente).
 */
export function buildBoletaDocumento(input: BoletaDteInput): BuildBoletaDocumentoResult {
  if (input.items.length === 0) throw new Error("buildBoletaDocumento: sin ítems");
  // El atributo ID es xs:ID → NCName: empieza con letra o '_', sin espacios ni
  // ':'. Si arranca con dígito (ej. "39-1") el SII rechaza. Ej. válido "F39T1".
  if (!/^[A-Za-z_][\w.-]*$/.test(input.documentId)) {
    throw new Error(`buildBoletaDocumento: documentId inválido como xs:ID: "${input.documentId}" (debe empezar con letra/_ y no llevar espacios ni ':')`);
  }
  // Normaliza el RUT del receptor en UN solo punto → tanto el <RUTRecep> del XML como el
  // RUTRecep del TED (ambos leen input.receptor.rut) quedan idénticos y canónicos.
  input = { ...input, receptor: { ...input.receptor, rut: normRut(input.receptor.rut) } };
  const encabezado = buildEncabezado(input);
  const detalles = input.items.map((it, i) => buildDetalle(it, i + 1)).join("");
  const referencia = input.referencia ? buildReferencia(input.referencia, 1) : "";
  const ted = buildTedCompact(input);
  const tmstFirma = el("TmstFirma", input.tmstFirma);
  const documento =
    `<Documento ID="${escAttr(input.documentId)}">` +
    encabezado +
    detalles +
    referencia +
    ted +
    tmstFirma +
    `</Documento>`;
  return { documento, documentId: input.documentId };
}

/**
 * Arma el DTE completo de boleta FIRMADO: render del Documento + firma XMLDSig
 * enveloped con el cert (.pfx) + envoltorio `<DTE>`. Devuelve el XML Unicode con
 * declaración iso-8859-1; los bytes de transmisión = `encodeLatin1` (xml-signature).
 */
export function buildSignedBoletaDte(
  input: BoletaDteInput,
  pfxBytes: Uint8Array,
  password: string,
): string {
  const { documento, documentId } = buildBoletaDocumento(input);
  return signBoletaDte(documento, documentId, pfxBytes, password);
}
