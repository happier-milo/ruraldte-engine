// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// own.test.ts — RuralDteProvider (motor propio). Verifica emit() end-to-end con el
// fetch global stubbeado (semilla→token→envío), el sobre resultante, y que un
// tipo no-boleta lanza ProviderUnsupportedDocumentError.
// ============================================================================

import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import forge from "npm:node-forge@1.3.1";
import { chileParts, classifyEnvioEstado, mapEnvioStatus, mapLegacyOutcome, RuralDteProvider } from "./ruraldte.ts";
import {
  ProviderConfigError,
  type ProviderEmitRequest,
  type ProviderPollRequest,
  ProviderUnsupportedDocumentError,
} from "./types.ts";
import type { LegacyEnvioStatus } from "../engine/sii-legacy-upload.ts";

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64Mod(n: { toString(r: number): string }): string {
  let h = n.toString(16);
  if (h.length % 2) h = "0" + h;
  return forge.util.encode64(forge.util.hexToBytes(h));
}

function genCafXml(td: number): string {
  const kp = forge.pki.rsa.generateKeyPair({ bits: 512 });
  const M = b64Mod(kp.publicKey.n);
  return `<?xml version="1.0"?><AUTORIZACION><CAF version="1.0"><DA>` +
    `<RE>78416626-0</RE><RS>COMUNIDAD RURAL SPA</RS><TD>${td}</TD>` +
    `<RNG><D>1</D><H>5</H></RNG><FA>2026-06-08</FA>` +
    `<RSAPK><M>${M}</M><E>AQAB</E></RSAPK><IDK>100</IDK></DA>` +
    `<FRMA algoritmo="SHA1withRSA">${M}</FRMA></CAF>` +
    `<RSASK>${forge.pki.privateKeyToPem(kp.privateKey)}</RSASK></AUTORIZACION>`;
}
function makeTestPfxBytes(): Uint8Array {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [{ name: "commonName", value: "TEST" }, {
    name: "serialNumber",
    value: "22222222-2",
  }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], "pass", { algorithm: "3des" });
  const der = forge.asn1.toDer(p12).getBytes();
  const out = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) out[i] = der.charCodeAt(i);
  return out;
}

const SEMILLA_RESP =
  `<?xml version="1.0" encoding="UTF-8"?><SII:RESPUESTA xmlns:SII="http://www.sii.cl/XMLSchema">` +
  `<SII:RESP_BODY><SEMILLA>162802760102</SEMILLA></SII:RESP_BODY>` +
  `<SII:RESP_HDR><ESTADO>00</ESTADO></SII:RESP_HDR></SII:RESPUESTA>`;
const TOKEN_RESP = `<?xml version="1.0"?><SII:RESPUESTA xmlns:SII="http://www.sii.cl/XMLSchema">` +
  `<SII:RESP_HDR><ESTADO>00</ESTADO></SII:RESP_HDR>` +
  `<SII:RESP_BODY><TOKEN>TKN_TEST</TOKEN></SII:RESP_BODY></SII:RESPUESTA>`;

// Canal legacy (factura/DTE): token SOAP DTEWS + RECEPCIONDTE del DTEUpload.
const LEGACY_SEED_RESP =
  `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">` +
  `<SOAP-ENV:Body><ns1:getSeedResponse><ns1:getSeedReturn>` +
  `<SEMILLA>162802760102</SEMILLA>` +
  `</ns1:getSeedReturn></ns1:getSeedResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
const LEGACY_TOKEN_RESP =
  `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">` +
  `<SOAP-ENV:Body><ns1:getTokenResponse><ns1:getTokenReturn>` +
  `<TOKEN>TKN_LEGACY</TOKEN>` +
  `</ns1:getTokenReturn></ns1:getTokenResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
const LEGACY_UPLOAD_RESP =
  `<?xml version="1.0"?><RECEPCIONDTE><STATUS>0</STATUS><TRACKID>2515505801</TRACKID></RECEPCIONDTE>`;
// Estado del envío legacy (QueryEstUp/getEstUp): EPR = Envío Procesado (aceptado). El
// inner va XML-escapado dentro de getEstUpReturn (así lo devuelve el SII; parseSoapReturn lo desescapa).
const LEGACY_QUERY_EPR =
  `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">` +
  `<SOAP-ENV:Body><ns1:getEstUpResponse><ns1:getEstUpReturn xsi:type="xsd:string">` +
  `&lt;SII:RESPUESTA&gt;&lt;RESP_HDR&gt;&lt;ESTADO&gt;EPR&lt;/ESTADO&gt;` +
  `&lt;GLOSA&gt;Envio Procesado&lt;/GLOSA&gt;&lt;/RESP_HDR&gt;&lt;/SII:RESPUESTA&gt;` +
  `</ns1:getEstUpReturn></ns1:getEstUpResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

function installFetchStub(): { restore: () => void; urls: string[] } {
  const orig = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((url: string | URL | Request, _init?: RequestInit) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("boleta.electronica.semilla")) {
      return Promise.resolve(new Response(SEMILLA_RESP, { status: 200 }));
    }
    if (u.includes("boleta.electronica.token")) {
      return Promise.resolve(new Response(TOKEN_RESP, { status: 200 }));
    }
    if (u.includes("boleta.electronica.envio")) {
      return Promise.resolve(new Response(`{"trackid":987654}`, { status: 200 }));
    }
    // Canal legacy (factura/DTE): semilla SOAP → token → DTEUpload.
    if (u.includes("/DTEWS/CrSeed.jws")) {
      return Promise.resolve(new Response(LEGACY_SEED_RESP, { status: 200 }));
    }
    if (u.includes("/DTEWS/GetTokenFromSeed.jws")) {
      return Promise.resolve(new Response(LEGACY_TOKEN_RESP, { status: 200 }));
    }
    if (u.includes("/cgi_dte/UPL/DTEUpload")) {
      return Promise.resolve(new Response(LEGACY_UPLOAD_RESP, { status: 200 }));
    }
    if (u.includes("/DTEWS/QueryEstUp.jws")) {
      return Promise.resolve(new Response(LEGACY_QUERY_EPR, { status: 200 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = orig;
    },
    urls,
  };
}

function emitReq(documentType: number, exenta = false): ProviderEmitRequest {
  const total = 29800;
  const isNcNd = documentType === 56 || documentType === 61 ||
    documentType === 111 || documentType === 112;
  return {
    emisor: {
      rut: "78416626-0",
      legalName: "COMUNIDAD RURAL SPA",
      giro: "PLATAFORMA SAAS Y SERVICIOS DE TECNOLOGÍA INFORMÁTICA",
      address: "Martínez de Rozas 3550",
      city: "Quinta Normal",
      acteco: 620200, // requerido por factura; boleta lo ignora
    },
    credentials: {
      pfxBase64: bytesToB64(makeTestPfxBytes()),
      pfxPassword: "pass",
      cafXmlBase64: bytesToB64(new TextEncoder().encode(genCafXml(documentType))),
      certRut: "22222222-2",
    },
    documentType: documentType as ProviderEmitRequest["documentType"],
    folio: 1,
    receiver: {
      rut: "66666666-6",
      name: "Set de pruebas SII",
      giro: "Comercio",
      address: "San Diego 2222",
      city: "Santiago",
    },
    amounts: exenta ? { neto: 0, iva: 0, total } : { neto: 25042, iva: 4758, total },
    glosa: "Cambio de aceite",
    paymentForm: 1,
    serviceIndicator: 3,
    exemptIndicator: exenta ? 1 : 0,
    references: isNcNd
      ? [{
        referencedDocumentType: 33,
        referencedFolio: 100,
        referencedDate: "2026-06-01",
        reasonCode: 1,
        reason: "Anula factura 100",
      }]
      : undefined,
    certification: true,
    // La carátula del EnvioDTE la pone el EMISOR y el provider la exige: en cert es la
    // FchResol de la empresa en Maullín (2026-06-14 para este RUT), con NroResol 0. No
    // hay default — ver el test de abajo, que es por qué no lo hay.
    resolutionNumber: 0,
    resolutionDate: "2026-06-14",
  };
}

Deno.test("RuralDteProvider.emit: boleta 39 → sobre firmado + semilla→token→envío + TrackID", async () => {
  const { restore, urls } = installFetchStub();
  try {
    const resp = await new RuralDteProvider().emit(emitReq(39));
    assertEquals(resp.trackId, "987654");
    assertEquals(resp.certificacion, 1);
    assert(resp.xml && resp.xml.includes("<EnvioBOLETA"), "debe retornar el sobre EnvioBOLETA");
    assertStringIncludes(resp.xml!, "<SetDTE ID=");
    assertStringIncludes(resp.xml!, "<TipoDTE>39</TipoDTE>");
    // el flujo tocó los 3 endpoints del SII (semilla, token, envío), ambiente cert.
    assert(
      urls.some((u) => u.includes("apicert.sii.cl") && u.includes("semilla")),
      "GET semilla cert",
    );
    assert(urls.some((u) => u.includes("boleta.electronica.token")), "POST token");
    assert(urls.some((u) => u.includes("boleta.electronica.envio")), "POST envío");
  } finally {
    restore();
  }
});

Deno.test("A1: dos emisiones del mismo emisor/cert reusan el token (autentica 1 vez)", async () => {
  const { restore, urls } = installFetchStub();
  try {
    const provider = new RuralDteProvider(); // = un tick del worker
    await provider.emit(emitReq(39));
    await provider.emit(emitReq(39));
    const tokenPosts = urls.filter((u) => u.includes("boleta.electronica.token")).length;
    const seedGets = urls.filter((u) => u.includes("boleta.electronica.semilla")).length;
    assertEquals(tokenPosts, 1, "el token se cachea por tick → una sola autenticación para el lote");
    assertEquals(seedGets, 1, "la semilla también se pide una sola vez");
  } finally {
    restore();
  }
});

Deno.test("A1: una instancia NUEVA de provider re-autentica (caché por-tick, sin retención global)", async () => {
  const { restore, urls } = installFetchStub();
  try {
    await new RuralDteProvider().emit(emitReq(39)); // tick 1
    await new RuralDteProvider().emit(emitReq(39)); // tick 2 → otro provider
    const tokenPosts = urls.filter((u) => u.includes("boleta.electronica.token")).length;
    assertEquals(tokenPosts, 2, "cada tick autentica lo suyo; sin retención cross-tick del token");
  } finally {
    restore();
  }
});

// FchEmis/TmstFirma/TSTED en hora LOCAL de Chile (no UTC): cerca de medianoche el UTC
// cae en el día siguiente → FchEmis incorrecta. chileParts resuelve America/Santiago (+DST).
Deno.test("chileParts: convierte a hora local de Chile (corrige el borde de medianoche)", () => {
  // Junio = invierno Chile (UTC-4): 02:00Z → 22:00 del día ANTERIOR (la fecha cambia).
  assertEquals(chileParts(new Date("2026-06-08T02:00:00Z")), { fecha: "2026-06-07", iso: "2026-06-07T22:00:00" });
  // Enero = verano Chile (UTC-3, DST): 02:00Z → 23:00 del día anterior.
  assertEquals(chileParts(new Date("2026-01-08T02:00:00Z")), { fecha: "2026-01-07", iso: "2026-01-07T23:00:00" });
});

// C3 — re-firma DETERMINISTA: con el instante sellado (emittedAtIso) un re-emit
// produce bytes IDÉNTICOS → el SII deduplica en reintento (no duplica el folio si el
// primer envío llegó pero el ack se perdió). Sin esto, FchEmis/TmstFirma/TSTED/
// TmstFirmaEnv venían de new Date() y cada reintento divergía.
Deno.test("RuralDteProvider.emit: mismo emittedAtIso → sobre byte-idéntico (C3, boleta + factura)", async () => {
  for (const tipo of [39, 33]) {
    const { restore } = installFetchStub();
    try {
      // El MISMO request (mismas llaves CAF/pfx) + el MISMO instante sellado: es lo
      // que hace el worker al reusar freeze_emit_instant en un reintento.
      const req: ProviderEmitRequest = { ...emitReq(tipo), emittedAtIso: "2026-06-08T18:24:11" };
      const a = await new RuralDteProvider().emit(req);
      const b = await new RuralDteProvider().emit(req);
      assert(a.xml && b.xml, `tipo ${tipo}: ambas emisiones retornan el sobre`);
      assertEquals(a.xml, b.xml, `tipo ${tipo}: re-emit con el mismo emittedAtIso debe ser byte-idéntico`);
      // Usa la fecha SELLADA, no el reloj.
      assertStringIncludes(a.xml!, "<FchEmis>2026-06-08</FchEmis>");
    } finally {
      restore();
    }
  }
});

Deno.test("RuralDteProvider.emit: boleta 41 exenta (MntExe) también emite", async () => {
  const { restore } = installFetchStub();
  try {
    const resp = await new RuralDteProvider().emit(emitReq(41, true));
    assertEquals(resp.trackId, "987654");
    assertStringIncludes(resp.xml!, "<TipoDTE>41</TipoDTE>");
    assertStringIncludes(resp.xml!, "<MntExe>29800</MntExe>");
  } finally {
    restore();
  }
});

Deno.test("RuralDteProvider.emit: factura 33 → EnvioDTE por canal legacy (SOAP token→DTEUpload) + TrackID", async () => {
  const { restore, urls } = installFetchStub();
  try {
    const resp = await new RuralDteProvider().emit(emitReq(33));
    assertEquals(resp.trackId, "2515505801");
    assertEquals(resp.certificacion, 1);
    assert(resp.xml && resp.xml.includes("<EnvioDTE"), "debe retornar el sobre EnvioDTE");
    assertStringIncludes(resp.xml!, "<TipoDTE>33</TipoDTE>");
    assertStringIncludes(resp.xml!, "<Acteco>620200</Acteco>");
    assertStringIncludes(resp.xml!, "<TasaIVA>19</TasaIVA>");
    // Tocó el canal legacy de cert (maullin), NO la API REST de boleta.
    assert(urls.some((u) => u.includes("maullin.sii.cl/DTEWS/CrSeed.jws")), "semilla legacy cert");
    assert(urls.some((u) => u.includes("/cgi_dte/UPL/DTEUpload")), "POST DTEUpload");
    assert(!urls.some((u) => u.includes("boleta.electronica.envio")), "factura NO usa la REST de boleta");
  } finally {
    restore();
  }
});

Deno.test("RuralDteProvider.emit: factura 33 sin paymentForm válido → FmaPago=2 (v2.5, default crédito)", async () => {
  const { restore } = installFetchStub();
  try {
    const req = emitReq(33);
    req.paymentForm = 0; // inválido → debe defaultear a 2 (oblig. v2.5)
    const resp = await new RuralDteProvider().emit(req);
    assertStringIncludes(resp.xml!, "<FmaPago>2</FmaPago>");
  } finally {
    restore();
  }
});

Deno.test("RuralDteProvider.emit: NC 61 con referencia → EnvioDTE con FchRef + CodRef", async () => {
  const { restore } = installFetchStub();
  try {
    const resp = await new RuralDteProvider().emit(emitReq(61));
    assertEquals(resp.trackId, "2515505801");
    assertStringIncludes(resp.xml!, "<TipoDTE>61</TipoDTE>");
    assertStringIncludes(resp.xml!, "<TpoDocRef>33</TpoDocRef>");
    assertStringIncludes(resp.xml!, "<FchRef>2026-06-01</FchRef>");
    assertStringIncludes(resp.xml!, "<CodRef>1</CodRef>");
  } finally {
    restore();
  }
});

Deno.test("RuralDteProvider.emit: NC 61 sin referencia → ProviderConfigError", async () => {
  const req = emitReq(61);
  req.references = undefined;
  await assertRejects(
    () => new RuralDteProvider().emit(req),
    ProviderConfigError,
    "requiere al menos una referencia",
  );
});

Deno.test("RuralDteProvider.emit: factura sin emisor.acteco → ProviderConfigError", async () => {
  const req = emitReq(33);
  req.emisor.acteco = undefined;
  await assertRejects(() => new RuralDteProvider().emit(req), ProviderConfigError, "acteco");
});

// DirOrigen/CmnaOrigen van incondicionales en el <Emisor> del DTE: un emisor sin
// domicilio debe fallar como CONFIG (→ manual_pending), no emitir <CmnaOrigen/> vacío.
Deno.test("RuralDteProvider.emit: factura sin emisor.city → ProviderConfigError", async () => {
  const req = emitReq(33);
  req.emisor.city = undefined;
  await assertRejects(() => new RuralDteProvider().emit(req), ProviderConfigError, "emisor.address + emisor.city");
});

Deno.test("RuralDteProvider.emit: factura con emisor.address en blanco → ProviderConfigError", async () => {
  const req = emitReq(33);
  req.emisor.address = "   ";
  await assertRejects(() => new RuralDteProvider().emit(req), ProviderConfigError, "emisor.address + emisor.city");
});

Deno.test("RuralDteProvider.emit: boleta 39 sin emisor.city → ProviderConfigError", async () => {
  const req = emitReq(39);
  req.emisor.city = undefined;
  await assertRejects(() => new RuralDteProvider().emit(req), ProviderConfigError, "emisor.address + emisor.city");
});

Deno.test("RuralDteProvider.emit: guía 52 → EnvioDTE con IndTraslado + transporte (canal legacy)", async () => {
  const { restore, urls } = installFetchStub();
  try {
    const req = emitReq(52);
    req.despacho = { tipoDespacho: 2, indTraslado: 1 };
    req.transporte = { patente: "AB1234", dirDest: "Bodega Central", cmnaDest: "Maipú" };
    const resp = await new RuralDteProvider().emit(req);
    assertEquals(resp.trackId, "2515505801");
    assert(resp.xml && resp.xml.includes("<EnvioDTE"), "guía va por EnvioDTE");
    assertStringIncludes(resp.xml!, "<TipoDTE>52</TipoDTE>");
    assertStringIncludes(resp.xml!, "<IndTraslado>1</IndTraslado>");
    assertStringIncludes(resp.xml!, "<DirDest>Bodega Central</DirDest>");
    assert(urls.some((u) => u.includes("/cgi_dte/UPL/DTEUpload")), "guía usa canal legacy");
  } finally {
    restore();
  }
});

Deno.test("RuralDteProvider.emit: exportación 110 → EnvioDTE con TpoMoneda + receptor extranjero", async () => {
  const { restore } = installFetchStub();
  try {
    const req = emitReq(110);
    req.exportacion = {
      tpoMoneda: "DOLAR USA",
      fmaPagExp: 11,
      otraMoneda: { tpoMoneda: "PESO CL", mntTotOtrMnda: 26000000 },
    };
    req.receiver.extranjero = { nacionalidad: 563 };
    const resp = await new RuralDteProvider().emit(req);
    assertEquals(resp.trackId, "2515505801");
    assertStringIncludes(resp.xml!, "<TipoDTE>110</TipoDTE>");
    assertStringIncludes(resp.xml!, "<TpoMoneda>DOLAR USA</TpoMoneda>");
    assertStringIncludes(resp.xml!, "<Nacionalidad>563</Nacionalidad>");
  } finally {
    restore();
  }
});

Deno.test("RuralDteProvider.emit: guía 52 sin despacho → ProviderConfigError", async () => {
  await assertRejects(
    () => new RuralDteProvider().emit(emitReq(52)),
    ProviderConfigError,
    "guía 52 requiere",
  );
});

Deno.test("RuralDteProvider.emit: exportación 110 sin exportacion.tpoMoneda → ProviderConfigError", async () => {
  await assertRejects(
    () => new RuralDteProvider().emit(emitReq(110)),
    ProviderConfigError,
    "exportación",
  );
});

Deno.test("RuralDteProvider.emit: liquidación 43 → EnvioDTE con raíz <Liquidacion> + TpoDocLiq + Comisiones (canal legacy)", async () => {
  const { restore, urls } = installFetchStub();
  try {
    const req = emitReq(43);
    // Mirror del set 4919094-3: líneas con MontoItem + TpoDocLiq + comisión del mandatario.
    // El caller computa la fiscalidad (IVAProp=IVA comisión, IVATerc=IVA−IVAProp); el provider
    // es conducto. neto 387110 + exento 119103 + IVA 73551 − comisión (3185+605) = total 575974.
    req.amounts = { neto: 387110, iva: 73551, total: 575974 };
    req.liquidacion = {
      items: [
        { nombre: "NETO FACTURA ELECTRONICA 1515", cantidad: 1, precio: 0, montoItem: 387110, tpoDocLiq: 33 },
        { nombre: "EXENTO FACTURAS ELECTRONICAS", cantidad: 52, precio: 0, montoItem: 119103, exento: true, tpoDocLiq: 33 },
      ],
      comisiones: [{ tipoMovim: "C", glosa: "NETO COMISION FIJA", valComNeto: 3185, valComIVA: 605 }],
      exento: 119103,
      ivaProp: 605,
      ivaTerc: 72946,
      valComNeto: 3185,
      valComIVA: 605,
    };
    const resp = await new RuralDteProvider().emit(req);
    assertEquals(resp.trackId, "2515505801");
    assert(resp.xml && resp.xml.includes("<EnvioDTE"), "la liquidación va por EnvioDTE");
    assertStringIncludes(resp.xml!, "<TipoDTE>43</TipoDTE>");
    assertStringIncludes(resp.xml!, "<Liquidacion ID="); // raíz propia del 43 (no <Documento>)
    assertStringIncludes(resp.xml!, "<TpoDocLiq>33</TpoDocLiq>");
    assertStringIncludes(resp.xml!, "<IVAProp>605</IVAProp>");
    assertStringIncludes(resp.xml!, "<Comisiones>");
    assert(urls.some((u) => u.includes("/cgi_dte/UPL/DTEUpload")), "43 usa canal legacy");
  } finally {
    restore();
  }
});

Deno.test("RuralDteProvider.emit: 43 sin liquidacion.items → ProviderConfigError (no gasta folio)", async () => {
  await assertRejects(
    () => new RuralDteProvider().emit(emitReq(43)),
    ProviderConfigError,
    "liquidación-factura (43) requiere",
  );
});

Deno.test("RuralDteProvider.emit: factura de compra 46 con retención → ImptoReten + TpoTranCompra + IndAgente", async () => {
  const { restore, urls } = installFetchStub();
  try {
    const req = emitReq(46);
    // Cambio de sujeto (retención total del IVA): línea afecta con IndAgente=R + CPCS + CodImpAdic=15;
    // ImptoReten (15) y MntTotal sin el IVA retenido. 500×4152 = 2.076.000 neto; IVA 394.440 retenido.
    req.amounts = { neto: 2076000, iva: 394440, total: 2076000 };
    req.compra = {
      tpoTranCompra: 1,
      items: [
        { nombre: "Producto 1", cantidad: 500, precio: 4152, indAgente: true, cpcs: "PRODUCTO1", codImpAdic: 15 },
      ],
      impuestosReten: [{ tipo: 15, tasa: 19, monto: 394440 }],
      ivaNoRet: 0,
    };
    const resp = await new RuralDteProvider().emit(req);
    assertEquals(resp.trackId, "2515505801");
    assertStringIncludes(resp.xml!, "<TipoDTE>46</TipoDTE>");
    assertStringIncludes(resp.xml!, "<TpoTranCompra>1</TpoTranCompra>");
    assertStringIncludes(resp.xml!, "<IndAgente>R</IndAgente>");
    assertStringIncludes(resp.xml!, "<ImptoReten>");
    assert(urls.some((u) => u.includes("/cgi_dte/UPL/DTEUpload")), "46 usa canal legacy");
  } finally {
    restore();
  }
});

Deno.test("RuralDteProvider.emit: tipo no soportado (48) lanza ProviderUnsupportedDocumentError", async () => {
  await assertRejects(
    () => new RuralDteProvider().emit(emitReq(48)),
    ProviderUnsupportedDocumentError,
  );
});

Deno.test("RuralDteProvider.healthcheck: ok si la semilla responde", async () => {
  const { restore } = installFetchStub();
  try {
    const hc = await new RuralDteProvider().healthcheck();
    assert(hc.ok, "healthcheck debe ser ok con semilla 200");
  } finally {
    restore();
  }
});

// ── Mapeo de estados del ENVÍO de boleta (diagrama_estados_be) ──────────────

Deno.test("classifyEnvioEstado: EPR (procesado) → DOK aceptado", () => {
  assertEquals(classifyEnvioEstado("EPR", "").revisionEstado, "DOK");
});

Deno.test("classifyEnvioEstado: RPR (aceptado c/reparos) → DNK, NO rechazo", () => {
  // Clave: en factura RPR=rechazo, en boleta RPR=aceptado-con-reparos.
  assertEquals(classifyEnvioEstado("RPR", "").revisionEstado, "DNK");
});

Deno.test("classifyEnvioEstado: rechazos RPT/RFR/RCT/RCH/RCO/RSC → RCH", () => {
  // Set autoritativo del openapi (ResultadoEnvioDataRespuesta.estado), menos RPR.
  for (const c of ["RPT", "RFR", "RCT", "RCH", "RCO", "RSC"]) {
    assertEquals(classifyEnvioEstado(c, "x").revisionEstado, "RCH", `${c} debe ser RCH`);
  }
});

Deno.test("classifyEnvioEstado: intermedios REC/SOK/FOK/PRD/CRT/VOF → EPR pending", () => {
  for (const c of ["REC", "SOK", "FOK", "PRD", "CRT", "VOF"]) {
    assertEquals(classifyEnvioEstado(c, "").revisionEstado, "EPR", `${c} debe seguir pending`);
  }
});

Deno.test("classifyEnvioEstado: desconocido → EPR pending (no finalizar mal)", () => {
  assertEquals(classifyEnvioEstado("ZZZ", "").revisionEstado, "EPR");
  assertEquals(classifyEnvioEstado("", "").revisionEstado, "EPR");
});

Deno.test("mapEnvioStatus: HTTP 5xx → EPR pending (transitorio)", () => {
  assertEquals(mapEnvioStatus(503, "boom").revisionEstado, "EPR");
});

Deno.test("mapEnvioStatus: JSON {estado:EPR} → DOK; {estado:RPT} → RCH", () => {
  assertEquals(mapEnvioStatus(200, JSON.stringify({ estado: "EPR" })).revisionEstado, "DOK");
  assertEquals(mapEnvioStatus(200, JSON.stringify({ estado: "RPT" })).revisionEstado, "RCH");
});

Deno.test("mapEnvioStatus: XML <ESTADO>RPR</ESTADO> → DNK", () => {
  const xml = `<?xml version="1.0"?><RESP><ESTADO>RPR</ESTADO></RESP>`;
  assertEquals(mapEnvioStatus(200, xml).revisionEstado, "DNK");
});

Deno.test("RuralDteProvider.emit: factura 33 MIXTA (afecta+exenta) emite MntExe y línea exenta IndExe=1", async () => {
  const { restore } = installFetchStub();
  try {
    const req = emitReq(33);
    req.amounts = { neto: 20000, iva: 3800, total: 29800, exento: 6000 };
    const resp = await new RuralDteProvider().emit(req);
    assertStringIncludes(resp.xml!, "<MntExe>6000</MntExe>");
    assertStringIncludes(resp.xml!, "<MntNeto>20000</MntNeto>");
    assertStringIncludes(resp.xml!, "<MntTotal>29800</MntTotal>");
    assertStringIncludes(resp.xml!, "<IndExe>1</IndExe>");
  } finally {
    restore();
  }
});

Deno.test("RuralDteProvider.emit: boleta 39 MIXTA emite MntExe (la porción exenta no se pierde)", async () => {
  const { restore } = installFetchStub();
  try {
    const req = emitReq(39);
    req.amounts = { neto: 20000, iva: 3800, total: 29800, exento: 6000 };
    const resp = await new RuralDteProvider().emit(req);
    assertStringIncludes(resp.xml!, "<MntExe>6000</MntExe>");
    assertStringIncludes(resp.xml!, "<MntTotal>29800</MntTotal>");
    assertStringIncludes(resp.xml!, "<IndExe>1</IndExe>");
  } finally {
    restore();
  }
});

Deno.test("RuralDteProvider.emit: emisor sin giro → ProviderConfigError (GiroEmis minLength=1; no quema folio)", async () => {
  const { restore } = installFetchStub();
  try {
    for (const tipo of [33, 39]) {
      const req = emitReq(tipo);
      req.emisor = { ...req.emisor, giro: undefined };
      await assertRejects(() => new RuralDteProvider().emit(req), ProviderConfigError);
    }
  } finally {
    restore();
  }
});

function pollReq(documentType: number, trackId = "2515505801"): ProviderPollRequest {
  const e = emitReq(documentType);
  return { emisor: e.emisor, credentials: e.credentials, trackId, documentType, folio: 1, certification: true };
}

// Regresión del bug "la factura emite pero nunca se acepta": el estado se consulta en el
// MISMO canal por el que se envió. Factura → QueryEstUp (legacy), NO el endpoint boleta REST.
Deno.test("RuralDteProvider.poll: factura 46 → canal legacy QueryEstUp (NO boleta REST) → DOK en EPR", async () => {
  const { restore, urls } = installFetchStub();
  try {
    const resp = await new RuralDteProvider().poll(pollReq(46));
    assertEquals(resp.revisionEstado, "DOK"); // EPR (Envío Procesado) = aceptado
    assert(urls.some((u) => u.includes("/DTEWS/QueryEstUp.jws")), "poll de factura debe consultar QueryEstUp");
    assert(!urls.some((u) => u.includes("boleta.electronica.envio")), "poll de factura NO debe tocar el endpoint boleta");
  } finally {
    restore();
  }
});

Deno.test("RuralDteProvider.poll: boleta 39 → canal REST boleta.electronica.envio (NO QueryEstUp)", async () => {
  const { restore, urls } = installFetchStub();
  try {
    await new RuralDteProvider().poll(pollReq(39));
    assert(urls.some((u) => u.includes("boleta.electronica.envio")), "poll de boleta debe consultar el endpoint REST boleta");
    assert(!urls.some((u) => u.includes("/DTEWS/QueryEstUp.jws")), "poll de boleta NO debe tocar QueryEstUp");
  } finally {
    restore();
  }
});

Deno.test("mapLegacyOutcome: accepted→DOK, rejected→RCH, processing/unknown→EPR (sigue pending)", () => {
  const mk = (o: LegacyEnvioStatus["outcome"], estado: string | null = null): LegacyEnvioStatus => ({
    outcome: o,
    estado,
    glosa: null,
    raw: "",
  });
  assertEquals(mapLegacyOutcome(mk("accepted", "EPR")).revisionEstado, "DOK");
  assertEquals(mapLegacyOutcome(mk("rejected", "RCH")).revisionEstado, "RCH");
  assertEquals(mapLegacyOutcome(mk("processing", "REC")).revisionEstado, "EPR");
  assertEquals(mapLegacyOutcome(mk("unknown")).revisionEstado, "EPR");
});

Deno.test("mapLegacyOutcome: un estado que NO conocemos no se disfraza de 'en proceso'", () => {
  // 106 es el código de la CONSULTA, no del envío. Decirle "En proceso" dejó al
  // 33#12 de un cliente polleando 77 veces en 37 h sin que nadie pudiera notarlo.
  const s: LegacyEnvioStatus = {
    outcome: "unknown",
    estado: "106",
    glosa: "TrackId no encontrado",
    raw: "",
  };
  const out = mapLegacyOutcome(s);
  assertEquals(out.revisionEstado, "EPR"); // sigue siendo no-terminal: no inventamos veredicto
  assertStringIncludes(out.revisionDetalle ?? "", "no reconocido");
  assertStringIncludes(out.revisionDetalle ?? "", "106");
  assertStringIncludes(out.revisionDetalle ?? "", "TrackId no encontrado");
});

Deno.test("mapLegacyOutcome: 'en proceso' de verdad arrastra la glosa del SII", () => {
  const s: LegacyEnvioStatus = {
    outcome: "processing",
    estado: "REC",
    glosa: "Envio Recibido",
    raw: "",
  };
  const out = mapLegacyOutcome(s);
  assertStringIncludes(out.revisionDetalle ?? "", "En proceso (REC)");
  assertStringIncludes(out.revisionDetalle ?? "", "Envio Recibido");
});

Deno.test("emit legacy: el rechazo del SII lleva SU motivo, no la cabecera del RECEPCIONDTE", async () => {
  // Forma REAL que dejó ciego el diagnóstico de los folios 33#13 y 33#14 (cert,
  // 2026-09-05): RUTSENDER/RUTCOMPANY/FILE/TIMESTAMP ocupan los primeros ~200
  // chars, así que recortar por delante se queda con puro sobre y cero motivo.
  const RECHAZO = `<?xml version="1.0"?>\n<RECEPCIONDTE>\n <RUTSENDER>33333333-3</RUTSENDER>\n` +
    ` <RUTCOMPANY>76543210-K</RUTCOMPANY>\n <FILE>envio.xml</FILE>\n` +
    ` <TIMESTAMP>2026-09-04 22:17:02</TIMESTAMP>\n <STATUS>7</STATUS>\n` +
    ` <DETAIL>\n<ERROR>SCH-00010: Elemento Detalle no esperado</ERROR>\n</DETAIL>\n</RECEPCIONDTE>`;
  const orig = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/DTEWS/CrSeed.jws")) return Promise.resolve(new Response(LEGACY_SEED_RESP, { status: 200 }));
    if (u.includes("/DTEWS/GetTokenFromSeed.jws")) return Promise.resolve(new Response(LEGACY_TOKEN_RESP, { status: 200 }));
    if (u.includes("/cgi_dte/UPL/DTEUpload")) return Promise.resolve(new Response(RECHAZO, { status: 200 }));
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
  try {
    const err = await assertRejects(() => new RuralDteProvider().emit(emitReq(33)));
    const msg = err instanceof Error ? err.message : String(err);
    assertStringIncludes(msg, "STATUS 7");
    assertStringIncludes(msg, "SCH-00010: Elemento Detalle no esperado");
    // Y el sobre NO se lleva el presupuesto: si vuelve el recorte por delante,
    // esto se pone rojo antes de que otro cliente pierda un folio a ciegas.
    assert(!msg.includes("RUTSENDER"), `el motivo no debe quedar sepultado por la cabecera: ${msg}`);
  } finally {
    globalThis.fetch = orig;
  }
});

// ============================================================================
// La resolución de la carátula no se adivina
// ----------------------------------------------------------------------------
// Había un default `?? "2014-08-22"` —la Res. Ex. de BOLETA de producción— que
// convertía un emisor sin `fch_resol` en un DTE rechazado con el folio ya gastado
// (CRT-3-19 "Fecha/Numero Resolucion Invalido", que solo valida el canal legacy). En
// certificación la fecha es particular de cada empresa: no hay valor adivinable. Y el
// default ni era coherente: pegaba NroResol 0 (el de cert) con una fecha de producción.
// El 2026-09-11, de los emisores de cert de la plataforma solo UNO tenía `fch_resol`.
// ============================================================================

Deno.test("emit EnvioDTE: sin resolutionDate → ProviderConfigError (antes inventaba 2014-08-22)", async () => {
  for (const tipo of [33, 61, 46]) {
    const req = emitReq(tipo);
    delete req.resolutionDate;
    await assertRejects(
      () => new RuralDteProvider().emit(req),
      ProviderConfigError,
      "resolutionDate",
    );
  }
});

Deno.test("emit EnvioDTE: la carátula lleva la resolución del emisor, no un default", async () => {
  const stub = installFetchStub();
  try {
    const req = emitReq(33);
    req.resolutionDate = "2026-06-14";
    const sobre = (await new RuralDteProvider().emit(req)).xml!;
    assertStringIncludes(sobre, "<FchResol>2026-06-14</FchResol>");
    assert(!sobre.includes("2014-08-22"), "se fue con la resolución de producción de boleta");
  } finally {
    stub.restore();
  }
});
