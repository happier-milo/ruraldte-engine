// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Arma los tres acuses firmados del intercambio de DTE entre contribuyentes:
 * RecepcionEnvio (declara que el sobre llegó conforme), ResultadoDTE (acepta o
 * rechaza el contenido) y EnvioRecibos de la Ley 19.983 (acredita la recepción de
 * la mercadería, lo que deja el DTE cedible para factoring).
 *
 * Solo construye y firma: `parseInboundEnvioDte` saca del sobre recibido lo que los
 * acuses necesitan —carátula, DTEs, DigestValue del SetDTE— con regex sobre el
 * string, sin validar XSD ni verificar una sola firma (`setId` y `digest` pueden
 * venir null). Antes de firmar un EnvioRecibos pasa el sobre por `verifyInboundEnvio`
 * de `@ruraldte/engine/firma` y acusa solo los DTEs con `signatureOk`: acreditar la
 * Ley 19.983 sobre un DTE cuya firma no validaste es el vector de fraude de
 * factoring. Una regla la aplica el módulo solo: si el `RUTRecep` de un DTE no calza
 * con el `RutReceptor` de la carátula (ambos presentes, comparación exacta), la
 * recepción sale con EstadoRecepDTE 3 pase lo que pase en `estadoRecepDte`, porque el
 * set de intercambio del SII manda a propósito un DTE dirigido a otro RUT. Cada build
 * devuelve `{ xml, bytes }` firmado sobre esa serialización exacta y ya en ISO-8859-1:
 * si reformateas el XML después de firmar, rompes el digest.
 *
 * @example
 * ```ts
 * import {
 *   buildEnvioRecibos,
 *   buildRespuestaRecepcionEnvio,
 *   buildRespuestaResultadoDte,
 * } from "@ruraldte/engine/intercambio";
 * import { verifyInboundEnvio } from "@ruraldte/engine/firma";
 *
 * const v = verifyInboundEnvio(await Deno.readTextFile("recibido.xml"));
 * if (!v.envelopeOk) throw new Error("firma del sobre inválida: no acuses nada");
 *
 * const inbound = { ...v, nmbEnvio: "recibido.xml" };
 * const ident = {
 *   rutResponde: "76543210-K", // tú, el receptor del DTE
 *   rutRecibe: v.rutEmisor,    // quien te lo envió
 *   mailContacto: "dte@ejemplo.cl",
 *   tmstFirma: new Date().toISOString().slice(0, 19),
 * };
 * const pfx = await Deno.readFile("firma.pfx"), pass = Deno.env.get("PFX_PASS")!;
 *
 * const recepcion = buildRespuestaRecepcionEnvio(inbound, ident, pfx, pass);
 * const resultado = buildRespuestaResultadoDte(inbound.dtes, ident, pfx, pass); // EstadoDTE 0
 * // Ley 19.983 (deja el DTE cedible): SOLO los DTEs con firma propia verificada.
 * const cedibles = inbound.dtes.filter((d) => d.signatureOk);
 * const recibos = cedibles.length
 *   ? buildEnvioRecibos(cedibles, ident, pfx, pass, { recinto: "Bodega Central" })
 *   : null;
 *
 * await Deno.writeFile("acuse.xml", recepcion.bytes); // Latin-1, tal cual se firmó
 * ```
 *
 * @module
 */
// ============================================================================
// intercambio.ts — WS-6: acuses del INTERCAMBIO de DTE (etapa 3 de la cert factura).
// ============================================================================
//
// La certificación de factura exige el "intercambio" entre contribuyentes (la
// boleta no lo pide): al recibir un EnvioDTE hay que responder con acuses firmados.
// Tres documentos (schemas en ~/Documents/SII Dev):
//
//   1. RespuestaDTE / RecepcionEnvio  → ACUSE DE RECIBO del envío ("recibí tu
//      EnvioDTE; el schema/firma están OK"). EstadoRecepEnv 0 = conforme.
//   2. RespuestaDTE / ResultadoDTE    → RESULTADO COMERCIAL ("acepto/rechazo el
//      contenido del DTE"). EstadoDTE 0 = aceptado · 2 = rechazado.
//   3. EnvioRecibos (Ley 19.983)      → RECIBO DE MERCADERÍAS/SERVICIOS: acredita
//      la recepción y hace el DTE CEDIBLE (base del factoring, WS-8/F8).
//
// Schemas: schema_ic/RespuestaEnvioDTE_v10.xsd, schema19983/EnvioRecibos_v10.xsd +
// Recibos_v10.xsd. La firma reutiliza signSiiXml (C14N real, "firmar lo que se
// serializa") — RespuestaDTE firma <Resultado ID>, EnvioRecibos firma <SetRecibos
// ID> y CADA <Recibo> firma su <DocumentoRecibo ID> (patrón sobre, como los DTEs).
// ============================================================================

import { encodeLatin1, signSiiXml } from "./xml-signature.ts";

const SII_NS = "http://www.sii.cl/SiiDte";
const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";

/** Texto FIJO del XSD (Recibos_v10) — Declaración de acuse de recibo Ley 19.983. */
const DECLARACION_LEY_19983 =
  "El acuse de recibo que se declara en este acto, de acuerdo a lo dispuesto en la " +
  "letra b) del Art. 4, y la letra c) del Art. 5 de la Ley 19.983, acredita que la " +
  "entrega de mercaderias o servicio(s) prestado(s) ha(n) sido recibido(s).";

function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
  return escText(s).replace(/"/g, "&quot;");
}
function el(tag: string, value: string | number): string {
  return `<${tag}>${escText(String(value))}</${tag}>`;
}

// ── Parser del EnvioDTE recibido ───────────────────────────────────────────

/**
 * Los datos de un DTE del sobre recibido que los tres acuses repiten.
 * `mntTotal` va en pesos enteros y `rutRecep` se compara literal contra el `RutReceptor`
 * de la carátula para decidir el EstadoRecepDTE, así que consérvalo con el mismo formato
 * en que venía en el XML.
 */
export type InboundDte = {
  tipoDte: number;
  folio: number;
  fchEmis: string;
  rutEmisor: string;
  rutRecep: string;
  mntTotal: number;
};

/**
 * El envío recibido reducido a lo que los acuses necesitan: carátula más los DTEs que trae.
 * `parseInboundEnvioDte` lo arma con regex sobre el string, sin validar XSD ni verificar una
 * sola firma: si viene sin `setId`, la recepción sale con `EnvioDTEID` `SetDoc`, y si viene
 * sin `digest`, el acuse se emite sin `<Digest>`.
 */
export type InboundEnvio = {
  /** ID del SetDTE recibido. */
  setId: string | null;
  /** Nombre del archivo del envío (para NmbEnvio del acuse). */
  nmbEnvio: string;
  /** RUT del emisor del envío (quien nos mandó el DTE). */
  rutEmisor: string;
  /** RUT de quien ENVÍA/firma el sobre (RutEnvia; = emisor en envío directo). */
  rutEnvia: string;
  /** RUT del receptor (nosotros). */
  rutReceptor: string;
  /** DigestValue del SetDTE recibido (de su firma) — para el acuse. */
  digest: string | null;
  dtes: InboundDte[];
};

/**
 * Extrae del EnvioDTE recibido los datos necesarios para construir los acuses:
 * metadata de la carátula + cada DTE (tipo/folio/fecha/ruts/total) + el digest
 * del SetDTE. Regex sobre el string (los DTE entrantes ya vienen firmados).
 */
export function parseInboundEnvioDte(xml: string, opts: { nmbEnvio?: string } = {}): InboundEnvio {
  const setId = xml.match(/<SetDTE\s+ID="([^"]+)"/)?.[1] ?? null;
  const caratula = xml.match(/<Caratula[^>]*>([\s\S]*?)<\/Caratula>/)?.[1] ?? "";
  const rutEmisor = caratula.match(/<RutEmisor>\s*([^<\s]+)\s*<\/RutEmisor>/)?.[1] ?? "";
  const rutEnvia = caratula.match(/<RutEnvia>\s*([^<\s]+)\s*<\/RutEnvia>/)?.[1] ?? "";
  const rutReceptor = caratula.match(/<RutReceptor>\s*([^<\s]+)\s*<\/RutReceptor>/)?.[1] ?? "";
  // Digest del SetDTE = el DigestValue de la Reference URI="#<setId>".
  const digest = setId
    ? xml.match(new RegExp(`<Reference\\s+URI="#${setId}">[\\s\\S]*?<DigestValue>([^<]+)</DigestValue>`))?.[1] ?? null
    : null;

  const dtes: InboundDte[] = [];
  for (const m of xml.matchAll(/<Documento\b[^>]*>([\s\S]*?)<\/Documento>/g)) {
    const doc = m[1];
    const enc = doc.match(/<Encabezado>([\s\S]*?)<\/Encabezado>/)?.[1] ?? doc;
    const idd = enc.match(/<IdDoc>([\s\S]*?)<\/IdDoc>/)?.[1] ?? "";
    const em = enc.match(/<Emisor>([\s\S]*?)<\/Emisor>/)?.[1] ?? "";
    const re = enc.match(/<Receptor>([\s\S]*?)<\/Receptor>/)?.[1] ?? "";
    const tot = enc.match(/<Totales>([\s\S]*?)<\/Totales>/)?.[1] ?? "";
    const intOf = (s: string, re2: RegExp) => parseInt(s.match(re2)?.[1] ?? "0", 10);
    dtes.push({
      tipoDte: intOf(idd, /<TipoDTE>(\d+)<\/TipoDTE>/),
      folio: intOf(idd, /<Folio>(\d+)<\/Folio>/),
      fchEmis: idd.match(/<FchEmis>\s*([^<\s]+)\s*<\/FchEmis>/)?.[1] ?? "",
      rutEmisor: em.match(/<RUTEmisor>\s*([^<\s]+)\s*<\/RUTEmisor>/)?.[1] ?? rutEmisor,
      rutRecep: re.match(/<RUTRecep>\s*([^<\s]+)\s*<\/RUTRecep>/)?.[1] ?? rutReceptor,
      mntTotal: intOf(tot, /<MntTotal>(\d+)<\/MntTotal>/),
    });
  }
  return {
    setId,
    nmbEnvio: opts.nmbEnvio ?? "EnvioDTE.xml",
    rutEmisor,
    rutEnvia,
    rutReceptor,
    digest,
    dtes,
  };
}

// ── Identidad del que responde (común a los 3 acuses) ──────────────────────

/**
 * Quién responde el acuse y a quién se le responde: los datos de carátula comunes a los tres
 * builders. `nmbContacto` se recorta a 40 caracteres y `mailContacto` a 80 al armar la carátula,
 * y `rutResponde` es además el `RutFirma` por omisión de cada recibo de la Ley 19.983.
 */
export type ResponderIdent = {
  /** RUT del que responde = receptor del DTE (nosotros). */
  rutResponde: string;
  /** RUT al que se le responde = emisor del DTE. */
  rutRecibe: string;
  nmbContacto?: string;
  mailContacto?: string;
  /** Timestamp de firma, AAAA-MM-DDThh:mm:ss. */
  tmstFirma: string;
};

/**
 * Lo que devuelve cada builder: `xml` es el documento ya firmado y `bytes` esa misma cadena
 * codificada en ISO-8859-1. Envía `bytes` tal cual: el digest se calculó sobre esa
 * serialización, así que reformatear el XML después de firmar lo rompe.
 */
type BuildResult = { xml: string; bytes: Uint8Array };

function wrapRespuesta(resultado: string, pfxBytes: Uint8Array, password: string, resultadoId: string): BuildResult {
  const unsigned = `<?xml version="1.0" encoding="ISO-8859-1"?>\r\n` +
    `<RespuestaDTE xmlns="${SII_NS}" xmlns:xsi="${XSI_NS}" ` +
    `xsi:schemaLocation="${SII_NS} RespuestaEnvioDTE_v10.xsd" version="1.0">\r\n` +
    `${resultado}\r\n</RespuestaDTE>`;
  // Sin re-formatear DESPUÉS de firmar (rompería el digest). Los acuses van por
  // email (intercambio), no por el gateway legacy line-based → no necesitan pretty.
  const xml = signSiiXml({
    xml: unsigned,
    signedElementTag: "Resultado",
    signedElementId: resultadoId,
    signedElementNs: SII_NS,
    pfxBytes,
    password,
  });
  return { xml, bytes: encodeLatin1(xml) };
}

function caratulaRespuesta(ident: ResponderIdent, idRespuesta: string | number, nroDetalles: number): string {
  return `<Caratula version="1.0">` +
    el("RutResponde", ident.rutResponde) +
    el("RutRecibe", ident.rutRecibe) +
    el("IdRespuesta", idRespuesta) +
    el("NroDetalles", nroDetalles) +
    (ident.nmbContacto ? el("NmbContacto", ident.nmbContacto.slice(0, 40)) : "") +
    (ident.mailContacto ? el("MailContacto", ident.mailContacto.slice(0, 80)) : "") +
    el("TmstFirmaResp", ident.tmstFirma) +
    `</Caratula>`;
}

// ── 1. Acuse de recibo del envío (RecepcionEnvio) ──────────────────────────

/**
 * Overrides de `buildRespuestaRecepcionEnvio`; todos son opcionales y los defaults acusan
 * conforme (EstadoRecepEnv 0, EstadoRecepDTE 0, CodEnvio 1, FchRecep = `tmstFirma`, glosa
 * "Envio Recibido Conforme"). `estadoRecepDte` no manda sobre un DTE dirigido a otro RUT —ahí
 * el acuse sale con EstadoRecepDTE 3 igual— y la glosa de cada DTE la fija el builder.
 */
export type RecepcionEnvioOpts = {
  resultadoId?: string;
  idRespuesta?: string | number;
  /** EstadoRecepEnv: 0 = conforme. */
  estadoRecepEnv?: string;
  recepEnvGlosa?: string;
  /** EstadoRecepDTE por DTE: 0 = OK. */
  estadoRecepDte?: string;
  fchRecep?: string;
  /** CodEnvio (código del envío asignado por el receptor). */
  codEnvio?: number;
};

/**
 * RespuestaDTE/RecepcionEnvio — acuse de recibo del envío. Confirma que el
 * EnvioDTE se recibió y pasó schema/firma (EstadoRecepEnv 0), con el detalle por
 * DTE (EstadoRecepDTE 0). Es el 1er acuse del intercambio (automático).
 */
export function buildRespuestaRecepcionEnvio(
  inbound: InboundEnvio,
  ident: ResponderIdent,
  pfxBytes: Uint8Array,
  password: string,
  opts: RecepcionEnvioOpts = {},
): BuildResult {
  const resultadoId = opts.resultadoId ?? "Respuesta";
  const recepDtes = inbound.dtes.map((d) => {
    // EstadoRecepDTE (formato_ic.pdf §b campo 17): si el DTE va dirigido a OTRO RUT
    // (RUTRecep ≠ receptor del envío) se acusa "3: DTE No Recibido - Error en RUT Receptor";
    // si es para nosotros, "0: DTE Recibido OK". El SET DE INTERCAMBIO del cert manda a
    // propósito un DTE dirigido a otro RUT → acusar 0 da "EstadoRecepDTE (0) respuesta incorrecta".
    const rutMismatch = !!d.rutRecep && !!inbound.rutReceptor && d.rutRecep !== inbound.rutReceptor;
    const estado = rutMismatch ? "3" : (opts.estadoRecepDte ?? "0");
    const glosa = rutMismatch ? "DTE No Recibido - Error en RUT Receptor" : "DTE Recibido OK";
    return `<RecepcionDTE>` +
      el("TipoDTE", d.tipoDte) +
      el("Folio", d.folio) +
      el("FchEmis", d.fchEmis) +
      el("RUTEmisor", d.rutEmisor) +
      el("RUTRecep", d.rutRecep) +
      el("MntTotal", d.mntTotal) +
      el("EstadoRecepDTE", estado) +
      el("RecepDTEGlosa", glosa) +
      `</RecepcionDTE>`;
  }).join("");

  const recepEnvio = `<RecepcionEnvio>` +
    el("NmbEnvio", inbound.nmbEnvio.slice(0, 30)) +
    el("FchRecep", opts.fchRecep ?? ident.tmstFirma) +
    el("CodEnvio", opts.codEnvio ?? 1) +
    el("EnvioDTEID", inbound.setId ?? "SetDoc") +
    (inbound.digest ? el("Digest", inbound.digest) : "") +
    (inbound.rutEmisor ? el("RutEmisor", inbound.rutEmisor) : "") +
    (inbound.rutReceptor ? el("RutReceptor", inbound.rutReceptor) : "") +
    el("EstadoRecepEnv", opts.estadoRecepEnv ?? "0") +
    el("RecepEnvGlosa", opts.recepEnvGlosa ?? "Envio Recibido Conforme") +
    recepDtes +
    `</RecepcionEnvio>`;

  const resultado = `<Resultado ID="${escAttr(resultadoId)}">` +
    caratulaRespuesta(ident, opts.idRespuesta ?? 1, inbound.dtes.length) +
    recepEnvio +
    `</Resultado>`;
  return wrapRespuesta(resultado, pfxBytes, password, resultadoId);
}

// ── 2. Resultado comercial (ResultadoDTE) ──────────────────────────────────

/**
 * Un DTE recibido con su veredicto comercial para `buildRespuestaResultadoDte`.
 * Por defecto sale aceptado (EstadoDTE 0, glosa "DTE Aceptado OK"); si lo rechazas, cambia
 * `estado` Y `glosa`, porque la glosa no se deriva del estado.
 */
export type ResultadoDteItem = InboundDte & {
  /** EstadoDTE: 0 = aceptado · 1 = aceptado con discrepancias · 2 = rechazado. */
  estado?: string;
  glosa?: string;
  /** CodEnvio del DTE. */
  codEnvio?: number;
};

/**
 * RespuestaDTE/ResultadoDTE — resultado comercial: acepta (0) o rechaza (2) el
 * contenido de cada DTE recibido. Es el 2º acuse del intercambio.
 */
export function buildRespuestaResultadoDte(
  dtes: ResultadoDteItem[],
  ident: ResponderIdent,
  pfxBytes: Uint8Array,
  password: string,
  opts: { resultadoId?: string; idRespuesta?: string | number } = {},
): BuildResult {
  const resultadoId = opts.resultadoId ?? "Respuesta";
  const resultados = dtes.map((d) =>
    `<ResultadoDTE>` +
    el("TipoDTE", d.tipoDte) +
    el("Folio", d.folio) +
    el("FchEmis", d.fchEmis) +
    el("RUTEmisor", d.rutEmisor) +
    el("RUTRecep", d.rutRecep) +
    el("MntTotal", d.mntTotal) +
    el("CodEnvio", d.codEnvio ?? 1) +
    el("EstadoDTE", d.estado ?? "0") +
    el("EstadoDTEGlosa", d.glosa ?? "DTE Aceptado OK") +
    `</ResultadoDTE>`
  ).join("");

  const resultado = `<Resultado ID="${escAttr(resultadoId)}">` +
    caratulaRespuesta(ident, opts.idRespuesta ?? 1, dtes.length) +
    resultados +
    `</Resultado>`;
  return wrapRespuesta(resultado, pfxBytes, password, resultadoId);
}

// ── 3. Recibo de mercaderías (EnvioRecibos, Ley 19.983) ────────────────────

/**
 * Un DTE a acreditar en el EnvioRecibos de la Ley 19.983.
 * `recinto` pisa para ese DTE el del build y se recorta a 80 caracteres; acá van solo DTEs
 * cuya firma propia verificaste, porque el recibo deja el documento cedible.
 */
export type ReciboItem = InboundDte & {
  /** Recinto de recepción de las mercaderías/servicios. */
  recinto?: string;
};

/** Un <Recibo> firmado (firma su <DocumentoRecibo ID>). */
function buildSignedRecibo(
  d: ReciboItem,
  rutFirma: string,
  tmstFirma: string,
  reciboId: string,
  recinto: string,
  pfxBytes: Uint8Array,
  password: string,
): string {
  const docRecibo = `<DocumentoRecibo ID="${escAttr(reciboId)}">` +
    el("TipoDoc", d.tipoDte) +
    el("Folio", d.folio) +
    el("FchEmis", d.fchEmis) +
    el("RUTEmisor", d.rutEmisor) +
    el("RUTRecep", d.rutRecep) +
    el("MntTotal", d.mntTotal) +
    el("Recinto", (d.recinto ?? recinto).slice(0, 80)) +
    el("RutFirma", rutFirma) +
    el("Declaracion", DECLARACION_LEY_19983) +
    el("TmstFirmaRecibo", tmstFirma) +
    `</DocumentoRecibo>`;
  // Recibo standalone firmado (DocumentoRecibo). Se firma envuelto en un doc mínimo
  // y se devuelve el <Recibo> con su Signature, para embeberlo en SetRecibos.
  const unsigned = `<?xml version="1.0" encoding="ISO-8859-1"?>` +
    `<Recibo xmlns="${SII_NS}" xmlns:xsi="${XSI_NS}" version="1.0">${docRecibo}</Recibo>`;
  const signed = signSiiXml({
    xml: unsigned,
    signedElementTag: "DocumentoRecibo",
    signedElementId: reciboId,
    signedElementNs: SII_NS,
    pfxBytes,
    password,
  });
  return signed.match(/<Recibo\b[\s\S]*<\/Recibo>/)?.[0] ?? signed;
}

/**
 * EnvioRecibos — recibo de mercaderías/servicios (Ley 19.983). Cada DTE recibido
 * genera un <Recibo> firmado; el SetRecibos los junta y se firma. Acredita la
 * recepción → habilita la cesión del crédito (factoring).
 */
export function buildEnvioRecibos(
  dtes: ReciboItem[],
  ident: ResponderIdent,
  pfxBytes: Uint8Array,
  password: string,
  opts: { setId?: string; rutFirma?: string; recinto?: string } = {},
): BuildResult {
  if (dtes.length === 0) throw new Error("buildEnvioRecibos: sin DTEs para acusar");
  const setId = opts.setId ?? "SetRecibos";
  const rutFirma = opts.rutFirma ?? ident.rutResponde;
  const recinto = opts.recinto ?? "Casa Matriz";

  const recibos = dtes
    .map((d, i) => buildSignedRecibo(d, rutFirma, ident.tmstFirma, `R${i + 1}`, recinto, pfxBytes, password))
    .join("");

  const caratula = `<Caratula version="1.0">` +
    el("RutResponde", ident.rutResponde) +
    el("RutRecibe", ident.rutRecibe) +
    (ident.nmbContacto ? el("NmbContacto", ident.nmbContacto.slice(0, 40)) : "") +
    (ident.mailContacto ? el("MailContacto", ident.mailContacto.slice(0, 80)) : "") +
    el("TmstFirmaEnv", ident.tmstFirma) +
    `</Caratula>`;

  const setRecibos = `<SetRecibos ID="${escAttr(setId)}">${caratula}${recibos}</SetRecibos>`;
  const unsigned = `<?xml version="1.0" encoding="ISO-8859-1"?>\r\n` +
    `<EnvioRecibos xmlns="${SII_NS}" xmlns:xsi="${XSI_NS}" ` +
    `xsi:schemaLocation="${SII_NS} EnvioRecibos_v10.xsd" version="1.0">\r\n` +
    `${setRecibos}\r\n</EnvioRecibos>`;
  const xml = signSiiXml({
    xml: unsigned,
    signedElementTag: "SetRecibos",
    signedElementId: setId,
    signedElementNs: SII_NS,
    pfxBytes,
    password,
  });
  return { xml, bytes: encodeLatin1(xml) };
}
