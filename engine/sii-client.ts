// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Cliente HTTP del API REST de boletas electrónicas del SII (Res. 74/2020): semilla,
 * token firmado, envío del sobre `EnvioBOLETA` y consulta de estado.
 *
 * La autenticación son tres pasos —pedir la semilla, firmarla con el `.pfx` (XMLDSig
 * enveloped, RSA-SHA1) y canjearla por un token que después viaja en `Cookie: TOKEN=…`—;
 * `authenticate` los hace de una y, como `getSemilla`/`getToken`, cae en `SII_USER_AGENT`
 * si no le pasas opciones: en cambio `sendEnvio` y las consultas de estado te exigen el
 * `userAgent` explícito, y el gateway de envío responde 401 si no calza el formato Mozilla
 * aunque el token esté vivo. Ese envío va por defecto a los hosts exclusivos (pangal en
 * cert, rahue en prod; `useAltEnvio` vuelve al host base, donde el path cae a un SOAP
 * muerto y sirve solo para diagnóstico) y serializa el multipart a mano por otra razón
 * distinta: con `FormData` el cuerpo sale chunked y ese gateway lee solo el primer chunk
 * (~4 KB), o sea el sobre le llega truncado. `parseSemilla`/`parseToken` sí revisan el
 * `<ESTADO>` y lanzan si no es 00, pero el envío y el estado te devuelven el cuerpo crudo
 * sin interpretarlo — y un `trackId` no es aceptación: hay que pollear.
 *
 * @example
 * ```ts
 * import {
 *   authenticate,
 *   getEnvioStatus,
 *   sendEnvio,
 *   SII_USER_AGENT,
 * } from "@ruraldte/engine/sii-client";
 *
 * const token = await authenticate("cert", pfxBytes, pfxPassword);
 *
 * const envio = await sendEnvio("cert", {
 *   xmlBytes,                  // EnvioBOLETA ya firmado, bytes iso-8859-1
 *   token,
 *   rutSender: "22222222-2",   // RUT del titular del certificado
 *   rutCompany: "76543210-K",  // RUT de la empresa emisora
 *   userAgent: SII_USER_AGENT, // obligatorio: acá no hay default
 * });
 * if (!envio.trackId) throw new Error(`envío rechazado: HTTP ${envio.status} ${envio.raw}`);
 *
 * const estado = await getEnvioStatus("cert", {
 *   rutCompany: "76543210-K", trackId: envio.trackId, token, userAgent: SII_USER_AGENT,
 * });
 * console.log(estado.status, estado.raw); // cuerpo tal cual: interpretarlo es tuyo
 * ```
 *
 * @module
 */
// ============================================================================
// sii-client.ts — Plan B, Fase 3: envío directo de boletas al SII.
// ============================================================================
//
// Cliente del API oficial "bolcoreinternetui" (OpenAPI "API SII - V1" v1.0.5).
// Flujo (Res. 74/2020):
//   1) GET  …/boleta.electronica.semilla            → <SEMILLA>
//   2) firmar la semilla (getToken, XMLDSig enveloped) con el cert
//   3) POST …/boleta.electronica.token  (xml)       → <TOKEN>
//   4) POST …/boleta.electronica.envio  (multipart) → TrackID   [Cookie: TOKEN, User-Agent]
//   5) GET  …/boleta.electronica.envio/{rut}-{dv}-{trackid}        → estado del envío
//      GET  …/boleta.electronica/{rut}-{dv}-{tipo}-{folio}/estado  → estado por boleta
//
// Servidores (del openapi): cert `apicert.sii.cl/recursos/v1` (alterno envío
// `pangal.sii.cl`), prod `api.sii.cl/recursos/v1` (alterno envío `rahue.sii.cl`).
// El servidor principal expone TODOS los paths (envío incluido) — los "temporal
// exclusivo envío" son alternos opcionales.
//
// Auth: el TOKEN va en header `Cookie: TOKEN=<token>` (apiKey, name=Cookie).
// `User-Agent` es header OBLIGATORIO en el envío.
//
// La firma de la semilla usa la C14N inclusiva real (c14n.ts) — mismo firmador
// XMLDSig que el sobre. node-forge para RSA-SHA1.
// ============================================================================

import forge from "npm:node-forge@1.3.1";
import { canonicalize, parseXml } from "./c14n.ts";
import { sha1Base64 } from "./xml-signature.ts";
import { extractPemFromPkcs12 } from "./pkcs12.ts";

const DSIG_NS = "http://www.w3.org/2000/09/xmldsig#";
const C14N_ALGO = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const SIG_ALGO = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";
const DIGEST_ALGO = "http://www.w3.org/2000/09/xmldsig#sha1";
const ENVELOPED_ALGO = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";

/** Ambiente del SII contra el que corre cada llamada: `"cert"` (certificación) o `"prod"`. Selecciona a la vez el host base —semilla, token y estados— y el host exclusivo de envío. */
export type SiiEnv = "cert" | "prod";

// ⚠️ HALLAZGO VIVO (Maullín 2026-06-10): el ENVÍO solo funciona en los hosts
// "exclusivo envío" (pangal/rahue) — en apicert el path /boleta.electronica.envio
// cae a un gateway SOAP muerto ("Acceso Denegado (from client)", mismo patrón que
// los /globales/*). semilla/token/estado sí viven en apicert/api. Además el
// gateway de envío EXIGE User-Agent con formato Mozilla (ver SII_USER_AGENT):
// con otro UA devuelve 401 "NO ESTA AUTENTICADO" aunque el token sea válido.
type ServerSet = { base: string; envio: string };
const SERVERS: Record<SiiEnv, ServerSet> = {
  cert: { base: "https://apicert.sii.cl/recursos/v1", envio: "https://pangal.sii.cl/recursos/v1" },
  prod: { base: "https://api.sii.cl/recursos/v1", envio: "https://rahue.sii.cl/recursos/v1" },
};
// Alterno de envío = el host base (documentado en el openapi pero con el path
// de envío misruteado a SOAP — conservado solo para diagnóstico).
/**
 * Host alterno de envío por ambiente: el mismo host base (`apicert`/`api`) que el OpenAPI
 * del SII documenta como servidor válido para el sobre.
 *
 * Lo usa `sendEnvio` cuando le pasas `useAltEnvio: true`. En la práctica ahí el path
 * `/boleta.electronica.envio` cae a un gateway SOAP muerto y responde "Acceso Denegado",
 * así que sirve solo para diagnóstico: el envío real va al host exclusivo (pangal/rahue).
 */
export const SII_ENVIO_ALT: Record<SiiEnv, string> = {
  cert: "https://apicert.sii.cl/recursos/v1",
  prod: "https://api.sii.cl/recursos/v1",
};

/**
 * User-Agent para TODA llamada al SII. El gateway de envío rechaza UAs que no
 * matcheen el formato clásico `Mozilla/4.0 (compatible; PROG 1.0; …)` (401
 * "NO ESTA AUTENTICADO", verificado vivo 2026-06-10 con el mismo token).
 */
export const SII_USER_AGENT = "Mozilla/4.0 (compatible; PROG 1.0; rural-saas-dte)";

/** Firma de `fetch` que aceptan las funciones del cliente en su campo `fetchFn`, para inyectar un doble en tests o un transporte propio. Si no la pasas, usan el `fetch` global. */
export type FetchFn = typeof fetch;

/** Divide "78416626-0" → { rut: 78416626, dv: "0" }. */
export function splitRut(rutConDv: string): { rut: number; dv: string } {
  const m = rutConDv.replace(/\./g, "").trim().match(/^(\d+)-?([0-9kK])$/);
  if (!m) throw new Error(`splitRut: RUT inválido "${rutConDv}"`);
  return { rut: parseInt(m[1], 10), dv: m[2].toUpperCase() };
}

/** BigInteger forge → base64 (CryptoBinary). */
function bigIntToBase64(bn: { toString(radix: number): string }): string {
  let hex = bn.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  return forge.util.encode64(forge.util.hexToBytes(hex));
}

// ---------------------------------------------------------------------------
// 1) Semilla
// ---------------------------------------------------------------------------

/** Extrae <SEMILLA> de la RESPUESTA del SII; verifica ESTADO=00. */
export function parseSemilla(xml: string): string {
  const estado = xml.match(/<ESTADO>([^<]*)<\/ESTADO>/)?.[1]?.trim();
  if (estado && estado !== "00") {
    const glosa = xml.match(/<GLOSA>([^<]*)<\/GLOSA>/)?.[1] ?? "";
    throw new Error(`getSemilla: ESTADO=${estado} ${glosa}`);
  }
  const seed = xml.match(/<SEMILLA>([^<]+)<\/SEMILLA>/)?.[1]?.trim();
  if (!seed) throw new Error("getSemilla: no se encontró <SEMILLA> en la respuesta");
  return seed;
}

/**
 * Pide la semilla al host base (paso 1 de la autenticación) y devuelve su valor ya extraído.
 *
 * @param env Ambiente del SII: define el host base al que se consulta.
 * @param opts Si omites el argumento completo, usa `SII_USER_AGENT`; si lo pasas, `userAgent` es
 * obligatorio. `fetchFn` reemplaza el `fetch` global.
 * @returns La semilla en texto plano, lista para pasársela a `buildSignedToken`.
 * @throws Error si el HTTP no es 2xx, si la respuesta trae `<ESTADO>` distinto de `00` (incluye la
 * glosa del SII) o si no viene `<SEMILLA>`.
 */
export async function getSemilla(
  env: SiiEnv,
  opts: { userAgent: string; fetchFn?: FetchFn } = { userAgent: SII_USER_AGENT },
): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(`${SERVERS[env].base}/boleta.electronica.semilla`, {
    method: "GET",
    headers: { "User-Agent": opts.userAgent, "Accept": "application/xml" },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`getSemilla: HTTP ${res.status} ${body.slice(0, 200)}`);
  return parseSemilla(body);
}

// ---------------------------------------------------------------------------
// 2) Firma de la semilla → getToken
// ---------------------------------------------------------------------------

/**
 * Arma y firma el `<getToken>` (XMLDSig enveloped, Reference URI="" = todo el
 * documento). El digest va sobre C14N(getToken sin la Signature) y la firma sobre
 * C14N(SignedInfo) — ambas con la C14N inclusiva real.
 */
export function buildSignedToken(seed: string, pfxBytes: Uint8Array, password: string): string {
  const { certPem, pkeyPem } = extractPemFromPkcs12(pfxBytes, password);
  const privateKey = forge.pki.privateKeyFromPem(pkeyPem);
  const certificate = forge.pki.certificateFromPem(certPem);

  const item = `<item><Semilla>${seed}</Semilla></item>`;
  // 1) digest: enveloped URI="" → el doc sin la Signature (aún no insertada).
  const digest = sha1Base64(canonicalize(parseXml(`<getToken>${item}</getToken>`).documentElement));

  // 2) KeyInfo
  const pub = certificate.publicKey;
  const modulus = bigIntToBase64(pub.n);
  const exponent = bigIntToBase64(pub.e);
  const x509 = forge.util.encode64(
    forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes(),
  );

  // 3) SignedInfo (Reference URI="" + transform enveloped) + Signature placeholder.
  const signedInfo = `<SignedInfo>` +
    `<CanonicalizationMethod Algorithm="${C14N_ALGO}"/>` +
    `<SignatureMethod Algorithm="${SIG_ALGO}"/>` +
    `<Reference URI="">` +
    `<Transforms><Transform Algorithm="${ENVELOPED_ALGO}"/></Transforms>` +
    `<DigestMethod Algorithm="${DIGEST_ALGO}"/>` +
    `<DigestValue>${digest}</DigestValue>` +
    `</Reference></SignedInfo>`;
  const PLACEHOLDER = "__SEED_SIGVALUE__";
  const signature = `<Signature xmlns="${DSIG_NS}">${signedInfo}` +
    `<SignatureValue>${PLACEHOLDER}</SignatureValue>` +
    `<KeyInfo><KeyValue><RSAKeyValue>` +
    `<Modulus>${modulus}</Modulus><Exponent>${exponent}</Exponent>` +
    `</RSAKeyValue></KeyValue>` +
    `<X509Data><X509Certificate>${x509}</X509Certificate></X509Data></KeyInfo></Signature>`;

  // 4) firmar el SignedInfo en contexto (hereda xmldsig#).
  const full = `<getToken>${item}${signature}</getToken>`;
  const si = parseXml(full).getElementsByTagName("SignedInfo")[0];
  const md = forge.md.sha1.create();
  md.update(canonicalize(si), "utf8");
  const signatureValue = forge.util.encode64(privateKey.sign(md));

  return `<?xml version="1.0"?>` + full.replace(PLACEHOLDER, signatureValue);
}

// ---------------------------------------------------------------------------
// 3) Token
// ---------------------------------------------------------------------------

/**
 * Extrae el `<TOKEN>` de la respuesta del canje y devuelve el token de sesión, ese que después
 * viaja en el header `Cookie: TOKEN=…`.
 *
 * @param xml Cuerpo tal cual lo devolvió `boleta.electronica.token`.
 * @throws Error si el cuerpo trae `<ESTADO>` distinto de `00` (lo reporta con la glosa) o si no
 * viene `<TOKEN>`. Una respuesta sin `<ESTADO>` no se considera error.
 */
export function parseToken(xml: string): string {
  const estado = xml.match(/<ESTADO>([^<]*)<\/ESTADO>/)?.[1]?.trim();
  if (estado && estado !== "00") {
    const glosa = xml.match(/<GLOSA>([^<]*)<\/GLOSA>/)?.[1] ?? "";
    throw new Error(`getToken: ESTADO=${estado} ${glosa}`);
  }
  const token = xml.match(/<TOKEN>([^<]+)<\/TOKEN>/)?.[1]?.trim();
  if (!token) throw new Error("getToken: no se encontró <TOKEN> en la respuesta");
  return token;
}

/**
 * Canjea el `<getToken>` firmado por un token de sesión en el host base (paso 3 de la
 * autenticación).
 *
 * @param env Ambiente del SII: define el host base al que se postea.
 * @param signedTokenXml El XML que devuelve `buildSignedToken` — se manda tal cual, acá no se firma
 * nada.
 * @param opts Si omites el argumento completo, usa `SII_USER_AGENT`; si lo pasas, `userAgent` es
 * obligatorio. `fetchFn` reemplaza el `fetch` global.
 * @returns El token de sesión, para el header `Cookie: TOKEN=…` del envío y de las consultas.
 * @throws Error si el HTTP no es 2xx, o lo que lance `parseToken` (`<ESTADO>` distinto de `00`, o
 * respuesta sin `<TOKEN>`).
 */
export async function getToken(
  env: SiiEnv,
  signedTokenXml: string,
  opts: { userAgent: string; fetchFn?: FetchFn } = { userAgent: SII_USER_AGENT },
): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(`${SERVERS[env].base}/boleta.electronica.token`, {
    method: "POST",
    headers: { "User-Agent": opts.userAgent, "Content-Type": "application/xml" },
    body: signedTokenXml,
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`getToken: HTTP ${res.status} ${body.slice(0, 200)}`);
  return parseToken(body);
}

/** Conveniencia: semilla → firma → token, en un paso. */
export async function authenticate(
  env: SiiEnv,
  pfxBytes: Uint8Array,
  password: string,
  opts: { userAgent: string; fetchFn?: FetchFn } = { userAgent: SII_USER_AGENT },
): Promise<string> {
  const seed = await getSemilla(env, opts);
  return getToken(env, buildSignedToken(seed, pfxBytes, password), opts);
}

// ---------------------------------------------------------------------------
// 4) Envío del sobre (multipart)
// ---------------------------------------------------------------------------

/**
 * Entrada de `sendEnvio`: el sobre ya firmado, el token de sesión, los dos RUT —que viajan partidos
 * en número y dígito verificador entre los campos del multipart— y el `User-Agent`.
 *
 * El sobre viaja byte a byte tal como se lo entregas: acá no se firma, no se valida ni se recodifica
 * nada.
 */
export type SendEnvioInput = {
  /** Bytes del EnvioBOLETA (iso-8859-1) — de buildEnvioBoleta. */
  xmlBytes: Uint8Array;
  /** Token de sesión (de getToken). */
  token: string;
  /** RUT de quien envía (cert/persona), ej "22222222-2". */
  rutSender: string;
  /** RUT de la empresa emisora, ej "78416626-0". */
  rutCompany: string;
  /** User-Agent (header OBLIGATORIO). */
  userAgent: string;
  /** Usar el servidor alterno "exclusivo envío" (pangal/rahue). Default false. */
  useAltEnvio?: boolean;
  fetchFn?: FetchFn;
  /** Nombre del archivo en el multipart. Default "envio.xml". */
  fileName?: string;
};

/**
 * Resultado del envío del sobre: el `trackId` cuando el SII acusa recibo, más el código HTTP y el
 * cuerpo crudo sin interpretar.
 *
 * `trackId` viene `null` si el HTTP no fue 2xx o si el cuerpo no traía un id reconocible —ahí el
 * detalle está en `raw`—, y un `trackId` tampoco es aceptación: hay que pollear el estado del envío.
 */
export type SendEnvioResult = {
  trackId: string | null;
  status: number;
  raw: string;
};

/** Extrae el TrackID de la respuesta JSON del envío (claves toleradas). */
export function parseTrackId(raw: string): string | null {
  try {
    const j = JSON.parse(raw);
    const v = j.trackid ?? j.trackId ?? j.TRACKID ?? j.track_id ?? j.id ?? null;
    return v === null || v === undefined ? null : String(v);
  } catch {
    return null;
  }
}

/**
 * Serializa el multipart/form-data A MANO como bytes.
 *
 * ⚠️ NO usar FormData como body: el runtime lo manda con Transfer-Encoding
 * chunked y el gateway legacy del SII solo lee el PRIMER chunk (~4 KB) —
 * observado vivo en Maullín 2026-06-10: sobre de 9,7 KB → "CHR-00002: Line
 * too long (4090)" con el sobre compacto y "LPX-00007: unexpected end-of-file"
 * con el sobre multilínea (= el archivo le llega truncado en ~4090 bytes).
 * Con el body como Uint8Array, fetch fija Content-Length y no hay chunked.
 */
export function buildEnvioMultipart(
  fields: [string, string][],
  fileName: string,
  fileBytes: Uint8Array,
  boundary: string,
): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [name, value] of fields) {
    parts.push(enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  }
  parts.push(enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="archivo"; filename="${fileName}"\r\n` +
      `Content-Type: application/xml\r\n\r\n`,
  ));
  parts.push(fileBytes);
  parts.push(enc.encode(`\r\n--${boundary}--\r\n`));

  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    body.set(p, offset);
    offset += p.length;
  }
  return body;
}

/**
 * Sube el sobre `EnvioBOLETA` al endpoint de envío como `multipart/form-data` serializado a mano y
 * devuelve el TrackID que el SII haya respondido.
 *
 * Por defecto apunta al host exclusivo de envío (pangal en cert, rahue en prod); `useAltEnvio` lo
 * manda al host base, que para este path está misruteado. Un rechazo del SII **no** lanza: revisa
 * `status` y `trackId` del resultado antes de darlo por enviado.
 *
 * @param env Ambiente del SII: define a qué host de envío se postea.
 * @param input Sobre, token, RUT del titular del certificado y de la empresa emisora, y el
 * `User-Agent` (obligatorio: el gateway responde 401 si no calza el formato Mozilla).
 * @returns `trackId` (o `null`), el HTTP `status` y el cuerpo `raw`.
 * @throws Error si alguno de los dos RUT no parsea, o lo que propague la llamada de red.
 */
export async function sendEnvio(env: SiiEnv, input: SendEnvioInput): Promise<SendEnvioResult> {
  const fetchFn = input.fetchFn ?? fetch;
  const base = input.useAltEnvio ? SII_ENVIO_ALT[env] : SERVERS[env].envio;
  const sender = splitRut(input.rutSender);
  const company = splitRut(input.rutCompany);

  const boundary = `----ruraldte${crypto.randomUUID().replace(/-/g, "")}`;
  const body = buildEnvioMultipart(
    [
      ["rutSender", String(sender.rut)],
      ["dvSender", sender.dv],
      ["rutCompany", String(company.rut)],
      ["dvCompany", company.dv],
    ],
    input.fileName ?? "envio.xml",
    input.xmlBytes,
    boundary,
  );

  const res = await fetchFn(`${base}/boleta.electronica.envio`, {
    method: "POST",
    headers: {
      "User-Agent": input.userAgent, // OBLIGATORIO
      "Cookie": `TOKEN=${input.token}`,
      "Accept": "application/json",
      // Body como bytes (NO FormData): Content-Length explícito, sin chunked.
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    // ArrayBuffer subyacente (asignación exacta en buildEnvioMultipart): mismos
    // bytes que el Uint8Array, pero tipa como BodyInit en todos los deno (el
    // lib.dom del CI rechaza Uint8Array<ArrayBufferLike>).
    body: body.buffer as ArrayBuffer,
  });
  const raw = await res.text();
  return { trackId: res.ok ? parseTrackId(raw) : null, status: res.status, raw };
}

// ---------------------------------------------------------------------------
// 5) Estado
// ---------------------------------------------------------------------------

/** Estado del envío por TrackID. */
export async function getEnvioStatus(
  env: SiiEnv,
  input: {
    rutCompany: string;
    trackId: string;
    token: string;
    userAgent: string;
    fetchFn?: FetchFn;
  },
): Promise<{ status: number; raw: string }> {
  const fetchFn = input.fetchFn ?? fetch;
  const { rut, dv } = splitRut(input.rutCompany);
  const url = `${SERVERS[env].base}/boleta.electronica.envio/${rut}-${dv}-${input.trackId}`;
  const res = await fetchFn(url, {
    method: "GET",
    headers: {
      "User-Agent": input.userAgent,
      "Cookie": `TOKEN=${input.token}`,
      "Accept": "application/json",
    },
  });
  return { status: res.status, raw: await res.text() };
}

/** Estado de una boleta por folio. */
export async function getBoletaStatus(
  env: SiiEnv,
  input: {
    rutCompany: string;
    tipo: number;
    folio: number;
    token: string;
    userAgent: string;
    /** Query: rut/dv receptor, monto, fecha (AAAA-MM-DD) — los exige el endpoint. */
    query?: Record<string, string | number>;
    fetchFn?: FetchFn;
  },
): Promise<{ status: number; raw: string }> {
  const fetchFn = input.fetchFn ?? fetch;
  const { rut, dv } = splitRut(input.rutCompany);
  const qs = input.query
    ? "?" +
      new URLSearchParams(Object.entries(input.query).map(([k, v]) => [k, String(v)])).toString()
    : "";
  const url = `${
    SERVERS[env].base
  }/boleta.electronica/${rut}-${dv}-${input.tipo}-${input.folio}/estado${qs}`;
  const res = await fetchFn(url, {
    method: "GET",
    headers: {
      "User-Agent": input.userAgent,
      "Cookie": `TOKEN=${input.token}`,
      "Accept": "application/json",
    },
  });
  return { status: res.status, raw: await res.text() };
}

// ---------------------------------------------------------------------------
// Tablas oficiales de códigos de estado (requieren token).
// ---------------------------------------------------------------------------

/** Tabla `/globales/boleta.electronica.*` que baja `getGlobalTable`: son los catálogos oficiales de códigos del SII (estado del envío, estado, nivel, sección y tipo). */
export type GlobalTable = "envio.estado" | "estado" | "nivel" | "seccion" | "tipo";

/** Baja una tabla /globales/* (fuente de verdad de DOK/RFR/etc.). Requiere token. */
export async function getGlobalTable(
  env: SiiEnv,
  table: GlobalTable,
  input: { token: string; userAgent: string; fetchFn?: FetchFn },
): Promise<{ status: number; raw: string }> {
  const fetchFn = input.fetchFn ?? fetch;
  const url = `${SERVERS[env].base}/globales/boleta.electronica.${table}`;
  const res = await fetchFn(url, {
    method: "GET",
    headers: {
      "User-Agent": input.userAgent,
      "Cookie": `TOKEN=${input.token}`,
      "Accept": "application/json",
    },
  });
  return { status: res.status, raw: await res.text() };
}
