// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// cert-ruraldte.test.ts — el SET de cert por el motor propio (primario):
// N DTEs (multi-ítem, ref SET, IndServicio) en UN sobre + envío directo SII.
// SII mockeado vía fetchFn (semilla → token → envío → trackId).
// ============================================================================

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import forge from "npm:node-forge@1.3.1";
import { emitCertSetViaRuralDte } from "./cert-ruraldte.ts";
import type { CertSetCase } from "./cert-harness.ts";

function genCafXml(): string {
  const kp = forge.pki.rsa.generateKeyPair({ bits: 512 });
  return (
    `<?xml version="1.0"?><AUTORIZACION><CAF version="1.0"><DA>` +
    `<RE>78416626-0</RE><RS>COMUNIDAD RURAL SPA</RS><TD>39</TD>` +
    `<RNG><D>1</D><H>10</H></RNG><FA>2026-06-10</FA>` +
    `<RSAPK><M>abc==</M><E>Aw==</E></RSAPK><IDK>100</IDK></DA>` +
    `<FRMA algoritmo="SHA1withRSA">deadbeef==</FRMA></CAF>` +
    `<RSASK>${forge.pki.privateKeyToPem(kp.privateKey)}</RSASK></AUTORIZACION>`
  );
}

function makeTestPfx(): Uint8Array {
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
  const bytes = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) bytes[i] = der.charCodeAt(i);
  return bytes;
}

/** Mock del SII: GET semilla → POST token → POST envío (multipart bytes). */
function mockSii() {
  const calls: { url: string; body?: BodyInit | null }[] = [];
  const fn = (async (input: URL | Request | string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ?? null });
    if (url.includes("semilla")) {
      return new Response("<R><ESTADO>00</ESTADO><SEMILLA>9966</SEMILLA></R>", { status: 200 });
    }
    if (url.includes("token")) {
      return new Response("<R><ESTADO>00</ESTADO><TOKEN>TOK123</TOKEN></R>", { status: 200 });
    }
    if (url.includes("envio")) {
      return new Response(JSON.stringify({ trackid: 777001, estado: "REC" }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

const CASES: CertSetCase[] = [
  {
    caso: "CASO-1",
    tipoDocumento: 39,
    items: [
      { nombre: "Cambio de aceite", cantidad: 1, precio: 19900 },
      { nombre: "Alineacion y balanceo", cantidad: 1, precio: 9900 },
    ],
  },
  {
    caso: "CASO-2",
    tipoDocumento: 39,
    items: [{ nombre: "Papel de regalo", cantidad: 17, precio: 120 }],
  },
  {
    caso: "CASO-4",
    tipoDocumento: 39,
    items: [
      { nombre: "Item afecto", cantidad: 8, precio: 1590 },
      { nombre: "Item exento", cantidad: 2, precio: 1000, exento: true },
    ],
  },
];

Deno.test("emitCertSetViaRuralDte: N DTEs ref-SET + IndServicio en UN sobre → trackId", async () => {
  const { fn, calls } = mockSii();
  const res = await emitCertSetViaRuralDte({
    cases: CASES,
    firstFolio: 6,
    fechaEmision: "2026-06-10",
    emisor: {
      rut: "78416626-0",
      legalName: "COMUNIDAD RURAL SPA",
      giro: "PLATAFORMA SAAS",
      address: "Dir 123",
      city: "Quinta Normal",
    },
    rutEnvia: "22222222-2",
    pfxBytes: makeTestPfx(),
    pfxPassword: "pass",
    cafXml: genCafXml(),
    tmstIso: "2026-06-10T12:00:00",
    fetchFn: fn,
  });

  assertEquals(res.trackId, "777001");
  assertEquals(res.sobreDocCount, 3);

  // UN sobre con los 3 DTE, folios consecutivos desde firstFolio.
  const dteCount = (res.sobreXml.match(/<DTE version="1.0">/g) ?? []).length;
  assertEquals(dteCount, 3);
  assertStringIncludes(res.sobreXml, "<Folio>6</Folio>");
  assertStringIncludes(res.sobreXml, "<Folio>7</Folio>");
  assertStringIncludes(res.sobreXml, "<Folio>8</Folio>");
  assertStringIncludes(res.sobreXml, "<NroDTE>3</NroDTE>");

  // IndServicio obligatorio (LSX-00213 sin él) + referencia literal del Set.
  assertEquals((res.sobreXml.match(/<IndServicio>3<\/IndServicio>/g) ?? []).length, 3);
  assertStringIncludes(res.sobreXml, "<TpoDocRef>SET</TpoDocRef>");
  assertStringIncludes(res.sobreXml, "<CodRef>SET</CodRef>"); // dual: el Set Prueba BE.txt instruye CodRef
  assertStringIncludes(res.sobreXml, "<RazonRef>CASO-1</RazonRef>");
  assertStringIncludes(res.sobreXml, "<RazonRef>CASO-4</RazonRef>");

  // CASO-4 mixto: ítem exento marcado + MntExe en totales.
  assertStringIncludes(res.sobreXml, "<IndExe>1</IndExe>");
  assertStringIncludes(res.sobreXml, "<MntExe>2000</MntExe>");

  // Tope SII: ninguna línea >4000 (tripwire de buildEnvioBoleta ya lo garantiza).
  const maxLine = Math.max(...res.sobreXml.split(/\r\n/).map((l) => l.length));
  assert(maxLine < 4000, `línea máxima ${maxLine}`);

  // Flujo SII: semilla → token → envío (a pangal, con Cookie TOKEN).
  assertEquals(calls.length, 3);
  assertStringIncludes(calls[0].url, "apicert.sii.cl");
  assertStringIncludes(calls[0].url, "semilla");
  assertStringIncludes(calls[1].url, "token");
  assertStringIncludes(calls[2].url, "pangal.sii.cl");
  assertStringIncludes(calls[2].url, "envio");
});

Deno.test("emitCertSetViaRuralDte: envío rechazado → throwea con el raw (para fallback)", async () => {
  const fn = (async (input: URL | Request | string) => {
    const url = String(input);
    if (url.includes("semilla")) {
      return new Response("<R><ESTADO>00</ESTADO><SEMILLA>1</SEMILLA></R>", { status: 200 });
    }
    if (url.includes("token")) {
      return new Response("<R><ESTADO>00</ESTADO><TOKEN>T</TOKEN></R>", { status: 200 });
    }
    return new Response("NO ESTA AUTENTICADO", { status: 401 });
  }) as typeof fetch;

  let threw = "";
  try {
    await emitCertSetViaRuralDte({
      cases: [CASES[0]],
      firstFolio: 1,
      fechaEmision: "2026-06-10",
      emisor: { rut: "78416626-0", legalName: "X" },
      rutEnvia: "22222222-2",
      pfxBytes: makeTestPfx(),
      pfxPassword: "pass",
      cafXml: genCafXml(),
      tmstIso: "2026-06-10T12:00:00",
      fetchFn: fn,
    });
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  assertStringIncludes(threw, "HTTP 401");
  assertStringIncludes(threw, "NO ESTA AUTENTICADO");
});
