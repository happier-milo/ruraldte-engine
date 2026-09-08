// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Construye, firma y registra el AEC (Archivo Electrónico de Cesión, Ley 19.983) para ceder
 * un DTE a un financista ante el RPETC del SII.
 *
 * Las TRES zonas firmadas —`DocumentoDTECedido`, `DocumentoCesion` y `DocumentoAEC`— van con el
 * mismo certificado, el del cedente, y el `tmstFirma` lo pones tú: mismo input, mismo XML.
 * `buildAEC` te da el string y los `bytes` ya en ISO-8859-1 —sube los bytes, y ojo que lanza si
 * algún carácter no cabe en ISO-8859-1—. Valida poco: exige al menos un autorizado, bota en
 * silencio del 4º en adelante y recorta los textos al largo del XSD sin avisar. De un sobre con
 * varios DTE embebe el del `idDte.folio`, pero si viene uno solo lo embebe tal cual, sin comparar
 * folio ni monto contra el `idDte`: esa verificación es tuya. El `trackId` de `aecUpload` no es
 * aceptación, hay que pollear `getEstEnvioAec`.
 *
 * @example
 * ```ts
 * import { aecUpload, buildAEC, getEstEnvioAec } from "@ruraldte/engine/aec";
 *
 * const { bytes } = buildAEC({
 *   dteXml, // el DTE 33 firmado, tal cual se envió al SII
 *   idDte: { tipoDte: 33, rutEmisor: "77777777-7", rutReceptor: "76543210-K",
 *            folio: 128, fchEmis: "2026-06-14", mntTotal: 119000 },
 *   cedente: { rut: "77777777-7", razonSocial: "PROVEEDOR SPA", direccion: "San Diego 100",
 *              email: "pagos@proveedor.cl",
 *              autorizados: [{ rut: "22222222-2", nombre: "Ana Soto" }] },
 *   cesionario: { rut: "88888888-8", razonSocial: "FACTORING SA",
 *                 direccion: "Apoquindo 3000", email: "ops@factoring.cl" },
 *   montoCesion: 119000,
 *   ultimoVencimiento: "2026-07-14",
 *   tmstFirma: "2026-06-14T12:30:00",
 *   pfxBytes, password, // cert del CEDENTE
 * });
 *
 * // `token` sale de getLegacyToken() (@ruraldte/engine/sii-legacy)
 * const up = await aecUpload("cert", {
 *   xmlBytes: bytes, token, rutCompany: "77777777-7", emailNotif: "pagos@proveedor.cl",
 * });
 * if (up.status !== 0 || !up.trackId) throw new Error(up.raw); // STATUS 0 = recibido
 * const st = await getEstEnvioAec("cert", { token, trackId: up.trackId });
 * console.log(st.estado, st.glosa);
 * ```
 *
 * @module
 */
// ============================================================================
// AEC — Archivo Electrónico de Cesión (factoring, Ley 19.983) · D10
// ----------------------------------------------------------------------------
// Construye y firma el AEC para CEDER un DTE (factura) a un financista, y lo
// REGISTRA en el RPETC del SII. Estructura verificada contra fuente oficial
// (cesion.pdf v1.1 + AEC_v10/Cesion_v10/DTECedido_v10.xsd) — ver
// docs/RURALDTE_D10_CESION_NORMATIVA.md.
//
// Reuso (NO se reimplementa cripto): la firma es 100% `signSiiXml` (C14N real,
// "firmar lo que se serializa"), igual que EnvioRecibos/ConsumoFolios. El upload
// es el MISMO patrón token+multipart que el EnvioDTE (sii-legacy-upload), a otro
// CGI. El poll es el MISMO patrón SOAP+token que la consulta de estado DTE.
//
// Estructura (AEC_v10.xsd):
//   AEC version="1.0"
//   └ DocumentoAEC ID
//     ├ Caratula (RutCedente, RutCesionario, NmbContacto?, FonoContacto?,
//     │           MailContacto?, TmstFirmaEnvio)
//     └ Cesiones
//       ├ DTECedido  → DocumentoDTECedido ID (DTE embebido + TmstFirma) + Signature
//       └ Cesion(1..40) → DocumentoCesion ID (SeqCesion, IdDTE, Cedente,
//                          Cesionario, MontoCesion, UltimoVencimiento, …) + Signature(1..3)
//   └ Signature (sobre DocumentoAEC)
// TRES firmas: DocumentoDTECedido, DocumentoCesion, DocumentoAEC. SHA1/RSA (= DTE).
// ============================================================================

import { encodeLatin1, signSiiXml } from "./xml-signature.ts";
import { splitRut } from "./sii-client.ts";
import { type LegacyEnv, parseSoapReturn } from "./sii-legacy-upload.ts";

const SII_NS = "http://www.sii.cl/SiiDte";
const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";

// Hosts del RPETC (espejan LEGACY_HOSTS de sii-legacy-upload, no exportado). El upload
// del AEC y el WS de consulta viven en el mismo host maullin/palena.
const RPETC_HOSTS: Record<LegacyEnv, string> = {
  cert: "https://maullin.sii.cl",
  prod: "https://palena.sii.cl",
};
const AEC_USER_AGENT = "Mozilla/4.0 (compatible; PROG 1.0; ruraldte)";

/** Firma del `fetch` global; los transportes la aceptan como `fetchFn` opcional para inyectar un doble en tests. */
type FetchFn = typeof fetch;

function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
  return escText(s).replace(/"/g, "&quot;");
}
function el(tag: string, value: string | number): string {
  return `<${tag}>${escText(String(value))}</${tag}>`;
}

// Tipos cedibles (DTEFacturasType del XSD): 33 factura, 34 exenta, 43 liquidación, 46 compra.
/**
 * Los cuatro tipos de DTE que el XSD deja ceder en un AEC (`DTEFacturasType`): 33 factura,
 * 34 exenta, 43 liquidación-factura y 46 factura de compra.
 */
export const TIPOS_CEDIBLES = [33, 34, 43, 46] as const;
/**
 * Tipo de DTE cedible, derivado de `TIPOS_CEDIBLES`.
 *
 * El chequeo es solo de compilación: `buildAEC` escribe el valor tal cual en `<TipoDTE>`, sin
 * revalidarlo en runtime.
 */
export type TipoCedible = (typeof TIPOS_CEDIBLES)[number];

/**
 * Identificación del DTE que se cede — el bloque `<IdDTE>` de la cesión.
 *
 * Tiene que calzar con el DTE embebido: si el XML trae un solo `<DTE>`, `buildAEC` lo embebe tal
 * cual sin comparar folio ni monto contra estos campos. Los RUT van en el formato `RUTType` del
 * XSD —sin puntos, con guión y la K en mayúscula (`76543210-K`)—, `fchEmis` en AAAA-MM-DD y
 * `mntTotal` en pesos enteros.
 */
export interface AecIdDte {
  tipoDte: TipoCedible;
  rutEmisor: string; // con DV (76xxxxxx-x)
  rutReceptor: string; // el deudor (con DV)
  folio: number;
  fchEmis: string; // AAAA-MM-DD (fecha emisión contable)
  mntTotal: number; // CLP entero
}

/**
 * Persona autorizada por el cedente a firmar la transferencia (`<RUTAutorizado>`).
 *
 * `rut` va sin puntos, con guión y la K en mayúscula; `nombre` se recorta a 60 caracteres al
 * serializar, pero el `NombreType` del XSD admite solo 40 — mándalo ya acotado.
 */
export interface AecAutorizado {
  rut: string; // con DV
  nombre: string;
}

/**
 * Datos del cedente —quien es dueño del crédito y lo transfiere— para el bloque `<Cedente>`.
 *
 * `buildAEC` lanza si `autorizados` viene vacío y descarta en silencio del 4º en adelante (el XSD
 * admite hasta 3). Razón social, dirección y correo se recortan sin avisar a 100/60/40 caracteres;
 * el XSD además exige dirección de al menos 5 caracteres y correo de al menos 6.
 */
export interface AecCedente {
  rut: string; // con DV
  razonSocial: string;
  direccion: string;
  email: string;
  /** 1..3 personas autorizadas a firmar la transferencia. */
  autorizados: AecAutorizado[];
  /** Obligatoria SOLO si el acuse de recibo es manual (sin Recibo electrónico). */
  declaracionJurada?: string;
}

/**
 * Datos del cesionario —el financista que recibe el crédito— para el bloque `<Cesionario>`.
 *
 * Mismos recortes silenciosos que el cedente —razón social 100, dirección 60 y correo 40
 * caracteres— y los mismos mínimos del XSD: dirección desde 5 caracteres, correo desde 6.
 */
export interface AecCesionario {
  rut: string; // con DV (el financista)
  razonSocial: string;
  direccion: string;
  email: string;
}

/**
 * Todo lo que `buildAEC` necesita: el DTE original ya firmado, las dos partes, las condiciones de
 * la cesión y el certificado que firma.
 *
 * El `pfxBytes`/`password` es el del CEDENTE y firma las tres zonas; `tmstFirma` lo pones tú y se
 * repite en las tres, así que el mismo input produce el mismo XML. `montoCesion` va en pesos
 * enteros y `ultimoVencimiento` en AAAA-MM-DD.
 */
export interface BuildAecInput {
  /** DTE original COMPLETO y firmado (string XML; se embebe en DTECedido). */
  dteXml: string;
  idDte: AecIdDte;
  cedente: AecCedente;
  cesionario: AecCesionario;
  montoCesion: number; // CLP entero (monto del crédito cedido)
  ultimoVencimiento: string; // AAAA-MM-DD
  otrasCondiciones?: string;
  emailDeudor?: string;
  seqCesion?: number; // 1..40 (default 1)
  /** Contacto de la carátula (opcionales). */
  nmbContacto?: string;
  fonoContacto?: string;
  mailContacto?: string;
  /** Timestamp AAAA-MM-DDTHH:MI:SS de la firma (lo provee el caller — determinista). */
  tmstFirma: string;
  /** Recibo(s) electrónico(s) del DTE (EnvioRecibos/Recibo XML) a embeber en DTECedido. */
  recibosXml?: string;
  /** PDF base64 del DTE cedido (ImagenDTE, opcional). */
  imagenDteBase64?: string;
  /** PDF base64 del acuse de recibo manual (ImagenAR, opcional). */
  imagenArBase64?: string;
  /** Cert del CEDENTE (firma las 3 zonas). */
  pfxBytes: Uint8Array;
  password: string;
  /** IDs de los elementos firmados (default deterministas). */
  ids?: { aec?: string; cesion?: string; dteCedido?: string };
}

/**
 * Salida de `buildAEC`: el AEC firmado como string y esos mismos caracteres ya codificados.
 *
 * Sube `bytes` tal cual al RPETC — el XML se declara `encoding="ISO-8859-1"` y `buildAEC` lanza al
 * codificar si algún carácter no cabe en Latin-1.
 */
export interface AecResult {
  xml: string;
  bytes: Uint8Array; // ISO-8859-1, listo para el upload
}

// Extrae el <DTE>…</DTE> del XML original. NON-greedy (`*?`) para NO tragar varios DTE
// de un sobre EnvioDTE; si hay más de uno, selecciona el del `folio` pedido (ceder el
// documento correcto, no el primero). Un greedy `[\s\S]*` embebía N DTE en un DocumentoDTECedido.
/**
 * Saca el `<DTE>…</DTE>` del XML original para embeberlo en el `DocumentoDTECedido`.
 *
 * @param dteXml XML del DTE firmado, o el sobre `EnvioDTE` que lo contiene.
 * @param folio Folio del documento a ceder; obligatorio cuando el XML trae más de un `<DTE>`. Con
 * uno solo se devuelve ese, sin comprobar que el folio calce.
 * @returns El fragmento `<DTE>…</DTE>` recortado tal cual del XML de entrada (no se reserializa).
 * @throws Si no hay ningún `<DTE>`, si hay varios y no pasaste `folio`, o si ninguno tiene ese folio.
 */
export function extractDte(dteXml: string, folio?: number): string {
  const all = dteXml.match(/<DTE\b[\s\S]*?<\/DTE>/g);
  if (!all || all.length === 0) throw new Error("buildAEC: no se encontró <DTE> en el XML del documento cedido");
  if (all.length === 1) return all[0];
  if (folio == null) throw new Error(`buildAEC: el XML trae ${all.length} DTE y no se indicó folio para elegir`);
  const match = all.find((d) => {
    const f = d.match(/<Folio>\s*(\d+)\s*<\/Folio>/)?.[1];
    return f != null && Number(f) === folio;
  });
  if (!match) throw new Error(`buildAEC: el XML trae ${all.length} DTE y ninguno con folio ${folio}`);
  return match;
}

// Extrae los <Recibo>…</Recibo> de un EnvioRecibos (o devuelve el fragmento tal cual).
function extractRecibos(recibosXml: string): string {
  const matches = recibosXml.match(/<Recibo\b[\s\S]*?<\/Recibo>/g);
  return matches ? matches.join("") : "";
}

// ── Zona B: DTECedido firmado (firma DocumentoDTECedido) ─────────────────────
function buildSignedDteCedido(input: BuildAecInput, docDteCedidoId: string): string {
  const dte = extractDte(input.dteXml, input.idDte.folio);
  const recibos = input.recibosXml ? extractRecibos(input.recibosXml) : "";
  const doc = `<DocumentoDTECedido ID="${escAttr(docDteCedidoId)}">` +
    dte +
    (input.imagenDteBase64 ? el("ImagenDTE", input.imagenDteBase64) : "") +
    recibos +
    (input.imagenArBase64 ? el("ImagenAR", input.imagenArBase64) : "") +
    el("TmstFirma", input.tmstFirma) +
    `</DocumentoDTECedido>`;
  const unsigned = `<?xml version="1.0" encoding="ISO-8859-1"?>` +
    `<DTECedido xmlns="${SII_NS}" xmlns:xsi="${XSI_NS}" version="1.0">${doc}</DTECedido>`;
  const signed = signSiiXml({
    xml: unsigned,
    signedElementTag: "DocumentoDTECedido",
    signedElementId: docDteCedidoId,
    signedElementNs: SII_NS,
    pfxBytes: input.pfxBytes,
    password: input.password,
  });
  return signed.match(/<DTECedido\b[\s\S]*<\/DTECedido>/)?.[0] ?? signed;
}

// ── Zona C: Cesion firmada (firma DocumentoCesion) ───────────────────────────
function buildSignedCesion(input: BuildAecInput, docCesionId: string): string {
  const c = input.cedente;
  if (!c.autorizados || c.autorizados.length === 0) {
    throw new Error("buildAEC: el cedente requiere al menos un RUTAutorizado");
  }
  const autorizados = c.autorizados.slice(0, 3)
    .map((a) => `<RUTAutorizado>${el("RUT", a.rut)}${el("Nombre", a.nombre.slice(0, 60))}</RUTAutorizado>`)
    .join("");

  const idDte = `<IdDTE>` +
    el("TipoDTE", input.idDte.tipoDte) +
    el("RUTEmisor", input.idDte.rutEmisor) +
    el("RUTReceptor", input.idDte.rutReceptor) +
    el("Folio", input.idDte.folio) +
    el("FchEmis", input.idDte.fchEmis) +
    el("MntTotal", input.idDte.mntTotal) +
    `</IdDTE>`;

  const cedente = `<Cedente>` +
    el("RUT", c.rut) +
    el("RazonSocial", c.razonSocial.slice(0, 100)) +
    el("Direccion", c.direccion.slice(0, 60)) +
    el("eMail", c.email.slice(0, 40)) +
    autorizados +
    (c.declaracionJurada ? el("DeclaracionJurada", c.declaracionJurada.slice(0, 512)) : "") +
    `</Cedente>`;

  const ce = input.cesionario;
  const cesionario = `<Cesionario>` +
    el("RUT", ce.rut) +
    el("RazonSocial", ce.razonSocial.slice(0, 100)) +
    el("Direccion", ce.direccion.slice(0, 60)) +
    el("eMail", ce.email.slice(0, 40)) +
    `</Cesionario>`;

  const doc = `<DocumentoCesion ID="${escAttr(docCesionId)}">` +
    el("SeqCesion", input.seqCesion ?? 1) +
    idDte +
    cedente +
    cesionario +
    el("MontoCesion", input.montoCesion) +
    el("UltimoVencimiento", input.ultimoVencimiento) +
    (input.otrasCondiciones ? el("OtrasCondiciones", input.otrasCondiciones.slice(0, 512)) : "") +
    (input.emailDeudor ? el("eMailDeudor", input.emailDeudor.slice(0, 40)) : "") +
    el("TmstCesion", input.tmstFirma) +
    `</DocumentoCesion>`;

  const unsigned = `<?xml version="1.0" encoding="ISO-8859-1"?>` +
    `<Cesion xmlns="${SII_NS}" xmlns:xsi="${XSI_NS}" version="1.0">${doc}</Cesion>`;
  const signed = signSiiXml({
    xml: unsigned,
    signedElementTag: "DocumentoCesion",
    signedElementId: docCesionId,
    signedElementNs: SII_NS,
    pfxBytes: input.pfxBytes,
    password: input.password,
  });
  return signed.match(/<Cesion\b[\s\S]*<\/Cesion>/)?.[0] ?? signed;
}

/** Construye y firma el AEC completo (3 firmas: DTECedido, Cesion, DocumentoAEC). */
export function buildAEC(input: BuildAecInput): AecResult {
  const ids = input.ids ?? {};
  const aecId = ids.aec ?? "RuralDTE_AEC";
  const cesionId = ids.cesion ?? "RuralDTE_CESION_1";
  const dteCedidoId = ids.dteCedido ?? "RuralDTE_DTECEDIDO";

  const signedDteCedido = buildSignedDteCedido(input, dteCedidoId);
  const signedCesion = buildSignedCesion(input, cesionId);

  const c = input.cedente;
  const caratula = `<Caratula version="1.0">` +
    el("RutCedente", c.rut) +
    el("RutCesionario", input.cesionario.rut) +
    (input.nmbContacto ? el("NmbContacto", input.nmbContacto.slice(0, 40)) : "") +
    (input.fonoContacto ? el("FonoContacto", input.fonoContacto.slice(0, 40)) : "") +
    (input.mailContacto ? el("MailContacto", input.mailContacto.slice(0, 40)) : "") +
    el("TmstFirmaEnvio", input.tmstFirma) +
    `</Caratula>`;

  const docAec = `<DocumentoAEC ID="${escAttr(aecId)}">` +
    caratula +
    `<Cesiones>${signedDteCedido}${signedCesion}</Cesiones>` +
    `</DocumentoAEC>`;

  const unsigned = `<?xml version="1.0" encoding="ISO-8859-1"?>` +
    `<AEC xmlns="${SII_NS}" xmlns:xsi="${XSI_NS}" ` +
    `xsi:schemaLocation="${SII_NS} AEC_v10.xsd" version="1.0">${docAec}</AEC>`;
  const xml = signSiiXml({
    xml: unsigned,
    signedElementTag: "DocumentoAEC",
    signedElementId: aecId,
    signedElementNs: SII_NS,
    pfxBytes: input.pfxBytes,
    password: input.password,
  });
  return { xml, bytes: encodeLatin1(xml) };
}

// ── Transporte: upload al RPETC + poll de estado ─────────────────────────────

/**
 * Respuesta del CGI del RPETC al subir el AEC, parseada desde `<RECEPCIONAEC>`.
 *
 * `status` 0 es recibido, no aceptado: hay que pollear con `getEstEnvioAec`, y el CGI solo entrega
 * `trackId` cuando el status es 0. Si la respuesta no trae `<STATUS>`, `status` queda en -1; `raw`
 * siempre conserva el cuerpo completo tal como llegó.
 */
export interface AecUploadResult {
  status: number; // 0 = OK
  trackId: string | null; // solo si status=0
  rutCompany: string | null;
  timestamp: string | null;
  raw: string;
}

/** Parsea la respuesta <RECEPCIONAEC> del CGI del RPETC. */
export function parseRecepcionAec(raw: string): AecUploadResult {
  const tag = (t: string) => raw.match(new RegExp(`<${t}>([^<]*)</${t}>`, "i"))?.[1]?.trim() ?? null;
  const statusStr = tag("STATUS");
  return {
    status: statusStr != null ? Number(statusStr) : -1,
    trackId: tag("TRACKID"),
    rutCompany: tag("RUTCOMPANY"),
    timestamp: tag("TIMESTAMP"),
    raw,
  };
}

function buildAecMultipart(
  fields: Array<[string, string]>,
  fileName: string,
  xmlBytes: Uint8Array,
  boundary: string,
): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [name, value] of fields) {
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="archivo"; filename="${fileName}"\r\n` +
      `Content-Type: text/xml\r\n\r\n`,
  ));
  parts.push(xmlBytes);
  parts.push(enc.encode(`\r\n--${boundary}--\r\n`));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Registra el AEC en el RPETC del SII (UPLOAD multipart al CGI /cgi_rtc/RTC/RTCAnotEnvio.cgi).
 * `trackId` ≠ aceptación → pollear getEstEnvioAec con el TRACKID. Reusa el token legacy (SOAP).
 */
export async function aecUpload(
  env: LegacyEnv,
  input: {
    xmlBytes: Uint8Array;
    token: string;
    /** RUT de la empresa CEDENTE (con DV). */
    rutCompany: string;
    emailNotif: string;
    fileName?: string;
    userAgent?: string;
    fetchFn?: FetchFn;
  },
): Promise<AecUploadResult> {
  const fetchFn = input.fetchFn ?? fetch;
  const company = splitRut(input.rutCompany);
  const boundary = `----ruraldte${crypto.randomUUID().replace(/-/g, "")}`;
  const body = buildAecMultipart(
    [
      ["emailNotif", input.emailNotif],
      ["rutCompany", String(company.rut)],
      ["dvCompany", company.dv],
    ],
    input.fileName ?? "AEC.xml",
    input.xmlBytes,
    boundary,
  );
  const res = await fetchFn(`${RPETC_HOSTS[env]}/cgi_rtc/RTC/RTCAnotEnvio.cgi`, {
    method: "POST",
    headers: {
      "User-Agent": input.userAgent ?? AEC_USER_AGENT,
      // SIN `Referer` — ver la nota en sii-legacy-upload.ts: el dominio de quien
      // construyó el motor no tiene por qué viajar en los envíos de otro.
      "Cookie": `TOKEN=${input.token}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: body.buffer as ArrayBuffer,
  });
  return parseRecepcionAec(await res.text());
}

/**
 * Estado del envío del AEC en el RPETC, tal como lo devuelve `getEstEnvioAec`.
 *
 * `estado` y `glosa` quedan en null si la respuesta SOAP no trae esos tags; `raw` conserva los
 * primeros 4000 caracteres de la respuesta para diagnosticar.
 */
export interface AecEnvioStatus {
  estado: string | null;
  glosa: string | null;
  raw: string;
}

/**
 * Estado del envío del AEC por TRACKID (SOAP wsRPETCConsulta.getEstEnvio).
 * Mismo patrón que la consulta de estado DTE legacy.
 */
export async function getEstEnvioAec(
  env: LegacyEnv,
  input: { token: string; trackId: string; fetchFn?: FetchFn },
): Promise<AecEnvioStatus> {
  const fetchFn = input.fetchFn ?? fetch;
  // Alineado con el patrón SOAP legacy VALIDADO VIVO del poll DTE (getLegacyEnvioStatus,
  // QueryEstUp): el DTEWS es Axis → la operación declara xmlns="http://DefaultNamespace",
  // los params van con xsi:type="xsd:string", y el TOKEN va TAMBIÉN en la cookie (no solo
  // en el body). Sin esto el service tira "No such operation" o auth-fail. La forma exacta
  // del WSDL de wsRPETCConsulta se confirma en el 1er smoke a Maullín (gasta nada).
  const body = `<getEstEnvio xmlns="http://DefaultNamespace">` +
    `<Token xsi:type="xsd:string">${escText(input.token)}</Token>` +
    `<TrackId xsi:type="xsd:string">${escText(input.trackId)}</TrackId>` +
    `</getEstEnvio>`;
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
  const res = await fetchFn(`${RPETC_HOSTS[env]}/DTEWS/services/wsRPETCConsulta`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=UTF-8",
      "SOAPAction": "",
      "User-Agent": AEC_USER_AGENT,
      "Cookie": `TOKEN=${input.token}`,
    },
    body: envelope,
  });
  const text = await res.text();
  const inner = parseSoapReturn(text, "getEstEnvioReturn") ?? text;
  // Regex namespaced (<ns:ESTADO>): la respuesta Axis puede traer prefijos de namespace.
  const tag = (t: string) => inner.match(new RegExp(`<[\\w:]*${t}>\\s*([\\s\\S]*?)\\s*</[\\w:]*${t}>`, "i"))?.[1]?.trim() ?? null;
  return { estado: tag("ESTADO"), glosa: tag("GLOSA"), raw: text.slice(0, 4000) };
}
