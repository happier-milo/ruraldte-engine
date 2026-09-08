// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// sii-legacy-upload.test.ts — parsers del canal legacy (SOAP DTEWS + DTEUpload)
// con fixtures de RESPUESTAS REALES capturadas en la cert SpA 2026-06-12.
// ============================================================================

import { assert, assertEquals } from "jsr:@std/assert@1";
import { getLegacyEnvioStatus, parseRecepcionDte, parseSoapReturn } from "./sii-legacy-upload.ts";

/** fetch falso: envuelve un XML interno en un getEstUpReturn (escapado) como maullin. */
function mockEstUpFetch(innerXml: string): typeof fetch {
  const esc = innerXml.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const soap = `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soapenv:Body><ns1:getEstUpResponse xmlns:ns1="https://maullin.sii.cl/DTEWS/QueryEstUp.jws">` +
    `<ns1:getEstUpReturn xsi:type="xsd:string">${esc}</ns1:getEstUpReturn>` +
    `</ns1:getEstUpResponse></soapenv:Body></soapenv:Envelope>`;
  return () => Promise.resolve(new Response(soap));
}

Deno.test("parseSoapReturn: extrae el return SOAP con namespace (forma real de maullin)", () => {
  // maullin responde con prefijo de namespace (ns1:getSeedReturn) y el XML interno escapado.
  const soap = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soapenv:Body><ns1:getSeedResponse xmlns:ns1="https://maullin.sii.cl/DTEWS/CrSeed.jws">` +
    `<ns1:getSeedReturn xsi:type="xsd:string" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `&lt;?xml version="1.0" encoding="UTF-8"?&gt;&lt;SII:RESPUESTA xmlns:SII="http://www.sii.cl/XMLSchema"&gt;` +
    `&lt;SII:RESP_BODY&gt;&lt;SEMILLA&gt;043871953686&lt;/SEMILLA&gt;&lt;/SII:RESP_BODY&gt;` +
    `&lt;/SII:RESPUESTA&gt;</ns1:getSeedReturn></ns1:getSeedResponse></soapenv:Body></soapenv:Envelope>`;
  const inner = parseSoapReturn(soap, "getSeedReturn");
  assert(inner);
  assertEquals(inner.match(/<SEMILLA>([^<]+)<\/SEMILLA>/)?.[1], "043871953686");
});

Deno.test("parseRecepcionDte: STATUS 0 con TRACKID (upload OK — RCOF real 0251552460)", () => {
  const raw = `<?xml version="1.0"?>\n<RECEPCIONDTE>\n <RUTSENDER>22222222-2</RUTSENDER>\n` +
    ` <RUTCOMPANY>78416626-0</RUTCOMPANY>\n <FILE>rcof.xml</FILE>\n` +
    ` <TIMESTAMP>2026-06-12 14:56:57</TIMESTAMP>\n <STATUS>0</STATUS>\n\n\n <TRACKID>0251552460</TRACKID>\n\n</RECEPCIONDTE>`;
  const r = parseRecepcionDte(raw);
  assertEquals(r.status, 0);
  assertEquals(r.trackId, "0251552460");
  assertEquals(r.dedup, false);
});

Deno.test("parseRecepcionDte: STATUS 7 esquema inválido (sin track)", () => {
  const raw = `<RECEPCIONDTE>\n <STATUS>7</STATUS>\n <DETAIL>\n<ERROR>SCH-00001: Invalid Schema Name</ERROR>\n</DETAIL>\n</RECEPCIONDTE>`;
  const r = parseRecepcionDte(raw);
  assertEquals(r.status, 7);
  assertEquals(r.trackId, null);
});

Deno.test("parseRecepcionDte: la glosa del rechazo sobrevive (STATUS 7 sin ella no se puede arreglar)", () => {
  const raw = `<RECEPCIONDTE>\n <STATUS>7</STATUS>\n <DETAIL>\n<ERROR>SCH-00001: Invalid Schema Name</ERROR>\n</DETAIL>\n</RECEPCIONDTE>`;
  assertEquals(parseRecepcionDte(raw).glosa, "SCH-00001: Invalid Schema Name");
});

Deno.test("parseRecepcionDte: la glosa NO se duplica cuando <DETAIL> envuelve al <ERROR>", () => {
  const raw = `<RECEPCIONDTE><STATUS>7</STATUS><DETAIL><ERROR>uno</ERROR></DETAIL></RECEPCIONDTE>`;
  assertEquals(parseRecepcionDte(raw).glosa, "uno");
});

Deno.test("parseRecepcionDte: varios <ERROR> se juntan (un esquema puede fallar en N elementos)", () => {
  const raw = `<RECEPCIONDTE><STATUS>7</STATUS><DETAIL>` +
    `<ERROR>ENV-00001: falta Caratula</ERROR><ERROR>DTE-00002: Detalle inválido</ERROR>` +
    `</DETAIL></RECEPCIONDTE>`;
  assertEquals(
    parseRecepcionDte(raw).glosa,
    "ENV-00001: falta Caratula · DTE-00002: Detalle inválido",
  );
});

Deno.test("parseRecepcionDte: sin tag conocido, la glosa cae al texto suelto tras </STATUS>", () => {
  // La forma que nos dejó a ciegas: la cabecera (RUTSENDER/RUTCOMPANY/FILE/
  // TIMESTAMP) se come el recorte por delante y el motivo va DESPUÉS del STATUS.
  const raw = `<?xml version="1.0"?>\n<RECEPCIONDTE>\n <RUTSENDER>33333333-3</RUTSENDER>\n` +
    ` <RUTCOMPANY>76543210-K</RUTCOMPANY>\n <FILE>envio.xml</FILE>\n` +
    ` <TIMESTAMP>2026-09-04 22:17:02</TIMESTAMP>\n <STATUS>7</STATUS>\n` +
    `  Documento no cumple con el esquema\n</RECEPCIONDTE>`;
  assertEquals(parseRecepcionDte(raw).glosa, "Documento no cumple con el esquema");
});

Deno.test("parseRecepcionDte: un upload OK no inventa glosa", () => {
  const raw = `<RECEPCIONDTE>\n <STATUS>0</STATUS>\n <TRACKID>0251552460</TRACKID>\n</RECEPCIONDTE>`;
  assertEquals(parseRecepcionDte(raw).glosa, null);
});

Deno.test("parseRecepcionDte: dedup 'ya fue enviado' devuelve el track previo", () => {
  const raw = `<RECEPCIONDTE>\n <STATUS>99</STATUS>\n <DETAIL>\n` +
    `<ERROR>Archivo ya fue enviado 2 veces con Trackid 251550580. Debe esperar 900 segundos antes de reintentar</ERROR>\n` +
    `</DETAIL>\n</RECEPCIONDTE>`;
  const r = parseRecepcionDte(raw);
  assertEquals(r.trackId, "251550580");
  assertEquals(r.dedup, true);
});

Deno.test("getLegacyEnvioStatus: ignora el ESTADO=0 (consulta correcta) y toma el estado de envío conocido (EPR)", async () => {
  const inner =
    `<?xml version="1.0"?><SII:RESPUESTA xmlns:SII="http://www.sii.cl/XMLSchema">` +
    `<SII:RESP_HDR><ESTADO>0</ESTADO><GLOSA>consulta correcta</GLOSA></SII:RESP_HDR>` +
    `<SII:RESP_BODY><TRACKID>251550580</TRACKID><ESTADO>EPR</ESTADO><GLOSA>Envio Procesado</GLOSA></SII:RESP_BODY>` +
    `</SII:RESPUESTA>`;
  const r = await getLegacyEnvioStatus("cert", {
    trackId: "251550580", rutSender: "22222222-2", rutCompany: "78416626-0", token: "TKN",
    fetchFn: mockEstUpFetch(inner),
  });
  assertEquals(r.estado, "EPR");
  assertEquals(r.outcome, "accepted");
  assertEquals(r.glosa, "Envio Procesado");
});

Deno.test("getLegacyEnvioStatus: forma VIVA de maullin — ESTADO=EPR en RESP_HDR, desglose por tipo en RESP_BODY", async () => {
  // Respuesta real de QueryEstUp por TrackId (2026-06-14): el estado del envío va
  // en RESP_HDR; RESP_BODY trae el conteo por tipo de documento (sin ESTADO).
  const inner =
    `<?xml version="1.0"?><SII:RESPUESTA xmlns:SII="http://www.sii.cl/XMLSchema">` +
    `<SII:RESP_BODY><TIPO_DOCTO>33</TIPO_DOCTO><INFORMADOS>4</INFORMADOS><ACEPTADOS>3</ACEPTADOS>` +
    `<RECHAZADOS>0</RECHAZADOS><REPAROS>1</REPAROS></SII:RESP_BODY>` +
    `<SII:RESP_HDR><TRACKID>0251753678</TRACKID><ESTADO>EPR</ESTADO><GLOSA>Envio Procesado</GLOSA></SII:RESP_HDR>` +
    `</SII:RESPUESTA>`;
  const r = await getLegacyEnvioStatus("cert", {
    trackId: "0251753678", rutSender: "22222222-2", rutCompany: "78416626-0", token: "TKN",
    fetchFn: mockEstUpFetch(inner),
  });
  assertEquals(r.estado, "EPR");
  assertEquals(r.outcome, "accepted");
  assertEquals(r.glosa, "Envio Procesado");
});

Deno.test("getLegacyEnvioStatus: RPR (rechazado) → outcome rejected", async () => {
  const inner = `<SII:RESP_BODY><ESTADO>RPR</ESTADO><GLOSA>Rechazado por reparos</GLOSA></SII:RESP_BODY>`;
  const r = await getLegacyEnvioStatus("cert", {
    trackId: "1", rutSender: "22222222-2", rutCompany: "78416626-0", token: "T", fetchFn: mockEstUpFetch(inner),
  });
  assertEquals(r.estado, "RPR");
  assertEquals(r.outcome, "rejected");
});

Deno.test("getLegacyEnvioStatus: REC (en proceso) → outcome processing", async () => {
  const inner = `<SII:RESP_BODY><ESTADO>REC</ESTADO></SII:RESP_BODY>`;
  const r = await getLegacyEnvioStatus("cert", {
    trackId: "1", rutSender: "22222222-2", rutCompany: "78416626-0", token: "T", fetchFn: mockEstUpFetch(inner),
  });
  assertEquals(r.estado, "REC");
  assertEquals(r.outcome, "processing");
});

Deno.test("getLegacyEnvioStatus: LSO (libro con schema correcto) → outcome accepted", async () => {
  // Estado de aceptación de un LIBRO (IEV/IEC/Guía): LSO, no EPR.
  const inner =
    `<SII:RESPUESTA xmlns:SII="http://www.sii.cl/XMLSchema">` +
    `<SII:RESP_HDR><TRACKID>251753692</TRACKID><ESTADO>LSO</ESTADO>` +
    `<GLOSA>Schema de Envio de Libro Correcto</GLOSA></SII:RESP_HDR></SII:RESPUESTA>`;
  const r = await getLegacyEnvioStatus("cert", {
    trackId: "251753692", rutSender: "22222222-2", rutCompany: "78416626-0", token: "T", fetchFn: mockEstUpFetch(inner),
  });
  assertEquals(r.estado, "LSO");
  assertEquals(r.outcome, "accepted");
});
