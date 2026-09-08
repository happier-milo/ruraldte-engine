// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Canal de envío legacy del SII (`maullin`/`palena`): token SOAP DTEWS, subida del XML por
 * multipart a `cgi_dte/UPL/DTEUpload` y consulta del estado del envío en `QueryEstUp`.
 *
 * Por acá viajan los sobres y libros del SII (EnvioDTE, EnvioBOLETA, ConsumoFolios/RVD, IEV/IEC/guía),
 * y es el almacén que lee el revisor del set de boletas: un envío impecable por la API REST igual sale
 * ahí como "El Documento no esta en el envio". El gateway es line-based (~4096 chars por línea), así que
 * `xmlBytes` deben ser los bytes latin1 de un XML PRETTY (acá no se formatea, no se valida ni se firma),
 * y deduplica por contenido: el mismo archivo reenviado responde STATUS 99 y vuelve con el track previo
 * y `dedup: true`. `legacyUpload` no lanza cuando el SII rechaza —devuelve `status`, `glosa` y
 * `trackId: null`—; el estado real lo trae después `getLegacyEnvioStatus`: `accepted` = EPR (sobres) o
 * LSO (libros).
 *
 * @example
 * ```ts
 * import { getLegacyEnvioStatus, getLegacyToken, legacyUpload } from "@ruraldte/engine/sii-legacy";
 *
 * const token = await getLegacyToken("cert", pfxBytes, pfxPassword);
 * const up = await legacyUpload("cert", {
 *   xmlBytes: sobre.bytes,    // bytes latin1 de un sobre PRETTY (ej. buildEnvioDte(...).bytes)
 *   token,
 *   rutSender: "22222222-2",  // firmante del .pfx, con permiso "Enviar Documentos"
 *   rutCompany: "76543210-K", // empresa emisora
 * });
 * // No hay excepción por STATUS: el rechazo se lee del resultado.
 * if (!up.trackId) throw new Error(`upload rechazado (STATUS ${up.status}): ${up.glosa}`);
 *
 * const st = await getLegacyEnvioStatus("cert", {
 *   trackId: up.trackId, rutSender: "22222222-2", rutCompany: "76543210-K", token,
 * });
 * console.log(st.estado, st.outcome); // "EPR" → "accepted" | "rejected" | "processing" | "unknown"
 * ```
 *
 * @module
 */
// ============================================================================
// sii-legacy-upload.ts — envío AUTOMÁTICO por el canal UPLOAD legacy del SII
// (maullin/palena `cgi_dte/UPL/DTEUpload`), con token SOAP clásico (DTEWS).
// ============================================================================
//
// Por qué existe (cert SpA 2026-06-12, manual §5b/§8): el REVISOR del set de
// boletas lee el almacén del canal legacy — un set perfecto en la API REST da
// "El Documento no esta en el envio" en la revisión. Además la doc oficial de
// la API dice que palena (= maullin en cert) es la plataforma que recibe el
// RVD/RCOF. Este módulo automatiza lo que antes era upload manual en la web:
//
//   1) getLegacyToken: semilla SOAP (CrSeed.jws) → firmar con el .pfx (mismo
//      <getToken> del REST, buildSignedToken) → GetTokenFromSeed.jws → TOKEN.
//   2) legacyUpload: POST multipart a /cgi_dte/UPL/DTEUpload (la forma EXACTA
//      del ejemplo del instructivo: rutSender/dvSender/rutCompany/dvCompany/
//      archivo + Cookie TOKEN + UA Mozilla/4.0 PROG) → RECEPCIONDTE con
//      STATUS + TRACKID (status 0 = recibido OK).
//
// Reglas duras del gateway (observadas vivas):
//   - Es LINE-BASED con tope ~4096 chars/línea: los XML van PRETTY (CRLF
//     entre tags, X509 envuelto) — un archivo en 1 línea rebota SCH-00001
//     "Invalid Schema Name" aunque el schema sea correcto.
//   - Dedup por contenido: el MISMO archivo re-enviado responde "Archivo ya
//     fue enviado N veces con Trackid X. Debe esperar 900 segundos" (status
//     99). Tratamos ese caso como éxito-idempotente devolviendo ese track.
//   - Status (manual envio.pdf 2003): 0=OK · 1=sin permiso · 5=no autenticado
//     · 6=empresa no autorizada · 7=esquema inválido · 99/otros=interno.
// ============================================================================

import { buildEnvioMultipart, buildSignedToken, type FetchFn, splitRut } from "./sii-client.ts";

/** Ambiente del canal legacy del SII: `"cert"` apunta a maullin.sii.cl y `"prod"` a palena.sii.cl. */
export type LegacyEnv = "cert" | "prod";

const LEGACY_HOSTS: Record<LegacyEnv, string> = {
  cert: "https://maullin.sii.cl",
  prod: "https://palena.sii.cl",
};

/** UA con la forma clásica que exige el gateway (ej. del instructivo). */
export const LEGACY_USER_AGENT = "Mozilla/4.0 (compatible; PROG 1.0; rural-saas-dte)";

function soapEnvelope(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:xsd="http://www.w3.org/2001/XMLSchema" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}

function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Extrae el contenido (XML-escapado) de <ns:tagReturn> de una respuesta SOAP. */
export function parseSoapReturn(soapBody: string, returnTag: string): string | null {
  const m = soapBody.match(
    new RegExp(`<[\\w:]*${returnTag}[^>]*>([\\s\\S]*?)</[\\w:]*${returnTag}>`),
  );
  return m ? xmlUnescape(m[1]) : null;
}

/**
 * Token de sesión del mundo legacy (DTEWS SOAP). Es DISTINTO del token REST de
 * boleta — mismo formato de semilla firmada, otro emisor/almacén de sesión.
 */
export async function getLegacyToken(
  env: LegacyEnv,
  pfxBytes: Uint8Array,
  password: string,
  opts: { userAgent?: string; fetchFn?: FetchFn } = {},
): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const userAgent = opts.userAgent ?? LEGACY_USER_AGENT;
  const base = LEGACY_HOSTS[env];

  const seedRes = await fetchFn(`${base}/DTEWS/CrSeed.jws`, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=UTF-8", "SOAPAction": "", "User-Agent": userAgent },
    body: soapEnvelope(`<m:getSeed xmlns:m="${base}/DTEWS/CrSeed.jws"/>`),
  });
  const seedBody = await seedRes.text();
  const seedInner = parseSoapReturn(seedBody, "getSeedReturn") ?? "";
  const semilla = seedInner.match(/<SEMILLA>([^<]+)<\/SEMILLA>/)?.[1];
  if (!semilla) {
    throw new Error(`getLegacyToken: sin SEMILLA (HTTP ${seedRes.status}): ${seedBody.slice(0, 200)}`);
  }

  const signedTokenXml = buildSignedToken(semilla, pfxBytes, password);
  const tokRes = await fetchFn(`${base}/DTEWS/GetTokenFromSeed.jws`, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=UTF-8", "SOAPAction": "", "User-Agent": userAgent },
    body: soapEnvelope(
      `<m:getToken xmlns:m="${base}/DTEWS/GetTokenFromSeed.jws">` +
        `<pszXml xsi:type="xsd:string">${xmlEscape(signedTokenXml)}</pszXml></m:getToken>`,
    ),
  });
  const tokBody = await tokRes.text();
  const tokInner = parseSoapReturn(tokBody, "getTokenReturn") ?? "";
  const token = tokInner.match(/<TOKEN>([^<]+)<\/TOKEN>/)?.[1];
  if (!token) {
    throw new Error(`getLegacyToken: sin TOKEN (HTTP ${tokRes.status}): ${tokBody.slice(0, 200)}`);
  }
  return token;
}

/**
 * Resultado de un upload al canal legacy, parseado del `RECEPCIONDTE` que devuelve el gateway.
 * Un `trackId` no nulo significa RECIBIDO, no aceptado: la validación de schema, firma y montos
 * la resuelve el SII después y la lees con `getLegacyEnvioStatus`.
 */
export type LegacyUploadResult = {
  /** Track del envío legacy (10 dígitos). null si el upload fue rechazado. */
  trackId: string | null;
  /** STATUS del RECEPCIONDTE (0 = OK). null si la respuesta no trae STATUS. */
  status: number | null;
  /** true si el gateway respondió "ya fue enviado" y reusamos ese track. */
  dedup: boolean;
  /**
   * POR QUÉ rechazó, en palabras del SII. El STATUS es un número sin glosa: "7"
   * dice "esquema inválido" pero no QUÉ elemento. El motivo viaja DESPUÉS del
   * <STATUS> en el cuerpo del RECEPCIONDTE, así que quien recorta la respuesta
   * por delante (`raw.slice(0, 200)`) se queda exactamente con la parte que no
   * sirve: RUTSENDER, RUTCOMPANY, FILE y TIMESTAMP ocupan el presupuesto entero.
   * Pasó de verdad: los folios 33#13 y 33#14 de un cliente en cert murieron con
   * "STATUS 7" y CERO información sobre el elemento culpable (2026-09-05).
   * null si la respuesta no trae motivo legible (ej. el STATUS 0 de éxito).
   */
  glosa: string | null;
  raw: string;
};

/** Parsea la respuesta RECEPCIONDTE del DTEUpload (incluye el caso dedup). */
export function parseRecepcionDte(raw: string): LegacyUploadResult {
  const status = raw.match(/<STATUS>\s*(\d+)\s*<\/STATUS>/)?.[1];
  const track = raw.match(/<TRACKID>\s*(\d+)\s*<\/TRACKID>/)?.[1];
  // Dedup: "Archivo ya fue enviado N veces con Trackid 251550580. Debe esperar…"
  const dedupTrack = raw.match(/ya fue enviado[\s\S]*?Trackid\s+(\d+)/i)?.[1];
  return {
    trackId: track ?? dedupTrack ?? null,
    status: status !== undefined ? parseInt(status, 10) : null,
    dedup: Boolean(dedupTrack),
    glosa: extractRecepcionGlosa(raw),
    raw,
  };
}

/**
 * Motivo legible del rechazo dentro del RECEPCIONDTE. El gateway no tiene UN
 * formato: según el error mete <ERROR>, <DETAIL>, <GLOSA> o texto suelto tras el
 * </STATUS>. Se prueban las tres formas conocidas y se cae al texto libre —
 * mejor un crudo acotado que un null que obliga a adivinar.
 */
function extractRecepcionGlosa(raw: string): string | null {
  // En orden de precisión, y el primero que dé texto GANA: <DETAIL> envuelve a los
  // <ERROR>, así que acumular ambos repetiría la misma glosa dos veces.
  for (const tag of ["ERROR", "GLOSA", "DETAIL"]) {
    const tagged: string[] = [];
    for (const m of raw.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi"))) {
      const txt = stripTags(m[1]);
      if (txt) tagged.push(txt);
    }
    if (tagged.length > 0) return tagged.join(" · ").slice(0, 400);
  }
  // Sin tag conocido: el texto que sigue al </STATUS> (donde el gateway suele
  // escribir la glosa suelta), sin el cierre del sobre y sin el TRACKID — que ahí
  // también vive y es un DATO, no un motivo: tomarlo devolvería "0251552460" como
  // glosa de un upload exitoso.
  const tail = raw.split(/<\/STATUS>/i)[1];
  if (!tail) return null;
  const txt = stripTags(
    tail
      .replace(/<\/RECEPCIONDTE>[\s\S]*$/i, "")
      .replace(/<TRACKID>[\s\S]*?<\/TRACKID>/gi, ""),
  );
  return txt ? txt.slice(0, 400) : null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Sube un XML (sobre EnvioBOLETA, EnvioDTE o ConsumoFolios/RVD) por el canal
 * legacy. ⚠️ `xmlBytes` deben ser los bytes latin1 de un XML PRETTY (líneas
 * <4096) — ver cabecera del módulo.
 */
export async function legacyUpload(
  env: LegacyEnv,
  input: {
    xmlBytes: Uint8Array;
    token: string;
    /** RUT de la persona que envía (firmante con "Enviar Documentos"). */
    rutSender: string;
    /** RUT de la empresa emisora. */
    rutCompany: string;
    fileName?: string;
    userAgent?: string;
    fetchFn?: FetchFn;
  },
): Promise<LegacyUploadResult> {
  const fetchFn = input.fetchFn ?? fetch;
  const userAgent = input.userAgent ?? LEGACY_USER_AGENT;
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

  const res = await fetchFn(`${LEGACY_HOSTS[env]}/cgi_dte/UPL/DTEUpload`, {
    method: "POST",
    headers: {
      "User-Agent": userAgent,
      // SIN `Referer`. Llevaba uno hardcodeado con el dominio de quien construyó el
      // motor, así que los envíos de CUALQUIER emisor viajaban con una marca ajena en
      // la cabecera. No lo pide nadie: el endpoint autentica con la cookie TOKEN, no
      // hay test que lo exija y entró con la implementación inicial, no como arreglo
      // de un rechazo. Si algún día el SII lo exigiera, va como parámetro del caller.
      "Cookie": `TOKEN=${input.token}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: body.buffer as ArrayBuffer,
  });
  return parseRecepcionDte(await res.text());
}

/**
 * Estado de un envío legacy (consulta `QueryEstUp.jws/getEstUp`). El DTEUpload
 * devuelve un trackId al instante con STATUS 0 = "recibido", pero la validación
 * real (schema/firma/montos) la resuelve el SII async → este poll trae el estado.
 *
 * Estados (RESP_BODY/ESTADO): EPR = Envío Procesado (los DTE pasaron, ≈ aceptado),
 * REC/SOK/PRD = en proceso, RFR/RPR/RCH/RSC/RCT/VOF = rechazado.
 */
export type LegacyEnvioStatus = {
  estado: string | null;
  glosa: string | null;
  outcome: "accepted" | "rejected" | "processing" | "unknown";
  /** XML de la respuesta (recortado) para diagnóstico/calibración en el 1er envío real. */
  raw: string;
};

// EPR = sobre DTE "Envío Procesado". LSO = libro (IEV/IEC/Guía) con "Schema de
// Envío de Libro Correcto" — el estado de aceptación de los LIBROS en QueryEstUp
// (validado vivo 2026-06-14; los libros NO devuelven EPR).
//
// QUIRK del desglose por tipo (RESP_BODY) del POLL en vivo: QueryEstUp NO enumera
// las Notas de Crédito (61) en el desglose <TIPO_DOCTO> — lista 33/34/46/52/56 y
// omite el 61 aunque el sobre las lleve y queden procesadas (envelope EPR).
// Verificado vivo 2026-06-15 contra DOS tracks (spanning 0251767784 + baseline
// 0251753678): ambos EPR, ambos sin bloque 61 en el poll. OJO: es SOLO el poll —
// el correo oficial de resultado del SII (RESULTADO_ENVIO / DTEMAIL<track>.xml) SÍ
// incluye el 61 con su aceptación (track 0251767784 → TIPODOC 61: INFORMADO 7,
// ACEPTA 7, 0 rechazos/reparos). No tratar la ausencia del 61 en el poll como error.
const LEGACY_ACCEPTED = new Set(["EPR", "LSO"]);
const LEGACY_PROCESSING = new Set(["REC", "SOK", "PRD", "PEN", "-11"]);
const LEGACY_REJECTED = new Set(["RFR", "RPR", "RCH", "RSC", "RCT", "RLV", "VOF", "RDC"]);

/**
 * Consulta el estado de un envío legacy por su trackId (`QueryEstUp.jws/getEstUp`).
 * `input.rutSender` no se manda: la operación del WSDL toma solo RUT de la empresa, trackId y
 * token, y agregar el consultante devuelve HTTP 500 (queda en la firma por compatibilidad).
 *
 * @param env Elige el host de la consulta (`"cert"` = maullin, `"prod"` = palena): usa el mismo ambiente donde subiste el envío.
 * @param input `token` es el del canal legacy (`getLegacyToken`), no el token REST de boleta; `fetchFn` reemplaza a `fetch` para tests.
 * @returns `estado` en mayúsculas: el primer `ESTADO` de la respuesta que sea un estado de envío conocido, ignorando el `ESTADO` 0 de "consulta correcta". `glosa` es la del envío (se descarta la de la consulta). `outcome` clasifica ese estado —EPR de sobres y LSO de libros ⇒ `"accepted"`— y `raw` trae la respuesta recortada a 4000 caracteres. Si no viene ningún `ESTADO`, `estado` queda en `null`; si viene uno fuera de las listas conocidas, se devuelve tal cual. En ambos casos `outcome` es `"unknown"`, que no es un rechazo.
 * @throws Lo que lance `fetchFn` (red caída, DNS, timeout). Una respuesta HTTP de error no lanza: queda ilegible y cae en `outcome: "unknown"`.
 */
export async function getLegacyEnvioStatus(
  env: LegacyEnv,
  input: {
    trackId: string;
    /** RUT del consultante (la persona firmante que envió). */
    rutSender: string;
    /** RUT de la empresa emisora. */
    rutCompany: string;
    token: string;
    userAgent?: string;
    fetchFn?: FetchFn;
  },
): Promise<LegacyEnvioStatus> {
  const fetchFn = input.fetchFn ?? fetch;
  const userAgent = input.userAgent ?? LEGACY_USER_AGENT;
  const base = LEGACY_HOSTS[env];
  const company = splitRut(input.rutCompany);

  // QueryEstUp.jws — el WSDL declara targetNamespace http://DefaultNamespace y la
  // operación getEstUp con SOLO 4 params: RutCompania, DvCompania, TrackId, Token.
  // Mandar 6 (con RutConsultante/DvConsultante) o el namespace del .jws daba Axis
  // "No such operation 'getEstUp'" (HTTP 500). input.rutSender ya no se envía
  // (queda en la firma por compat). Validado vivo vs maullin 2026-06-14.
  const body = `<getEstUp xmlns="http://DefaultNamespace">` +
    `<RutCompania xsi:type="xsd:string">${company.rut}</RutCompania>` +
    `<DvCompania xsi:type="xsd:string">${company.dv}</DvCompania>` +
    `<TrackId xsi:type="xsd:string">${xmlEscape(input.trackId)}</TrackId>` +
    `<Token xsi:type="xsd:string">${xmlEscape(input.token)}</Token>` +
    `</getEstUp>`;

  const res = await fetchFn(`${base}/DTEWS/QueryEstUp.jws`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=UTF-8",
      "SOAPAction": "",
      "User-Agent": userAgent,
      "Cookie": `TOKEN=${input.token}`,
    },
    body: soapEnvelope(body),
  });
  const inner = parseSoapReturn(await res.text(), "getEstUpReturn") ?? "";
  // El ESTADO del ENVÍO puede venir en RESP_HDR (forma viva por TrackId 2026-06-14:
  // <RESP_HDR><TRACKID/><ESTADO>EPR</ESTADO><GLOSA>Envio Procesado</GLOSA>) o en
  // RESP_BODY; RESP_HDR a veces trae además un ESTADO=0 = "consulta correcta", y
  // RESP_BODY puede traer el desglose por tipo. Tomamos el ESTADO cuyo valor es un
  // estado de envío CONOCIDO (EPR/RPR/REC/…), ignorando el 0 de la consulta.
  const estados = [...inner.matchAll(/<ESTADO>\s*([A-Za-z0-9-]+)\s*<\/ESTADO>/g)]
    .map((m) => m[1].toUpperCase());
  const isKnown = (e: string) => LEGACY_ACCEPTED.has(e) || LEGACY_REJECTED.has(e) || LEGACY_PROCESSING.has(e);
  const estado = estados.find(isKnown) ?? estados.find((e) => e !== "0") ?? estados[0] ?? null;
  // Glosa del envío (preferimos la que NO es la "consulta correcta" del RESP_HDR).
  const glosa = [...inner.matchAll(/<GLOSA(?:_ESTADO)?>\s*([\s\S]*?)\s*<\/GLOSA(?:_ESTADO)?>/g)]
    .map((m) => m[1].trim())
    .find((g) => g && !/consulta correcta/i.test(g)) ?? null;
  const outcome: LegacyEnvioStatus["outcome"] = estado === null
    ? "unknown"
    : LEGACY_ACCEPTED.has(estado)
    ? "accepted"
    : LEGACY_REJECTED.has(estado)
    ? "rejected"
    : LEGACY_PROCESSING.has(estado)
    ? "processing"
    : "unknown";
  return { estado, glosa, outcome, raw: inner.slice(0, 4000) };
}
