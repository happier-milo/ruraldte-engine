// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// intercambio.test.ts — WS-6: parser del EnvioDTE recibido + los 3 acuses firmados
// (RecepcionEnvio, ResultadoDTE, EnvioRecibos/Ley 19.983). La validez de schema se
// cubre aparte con xmllint (scripts/validate-intercambio-xsd.ts); acá: parsing,
// estructura, textos fijos y que las firmas verifiquen.
// ============================================================================

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import forge from "npm:node-forge@1.3.1";
import { buildCertFacturaDtes, type BuildCertFacturaArgs, type FacturaCertCase } from "./cert-factura.ts";
import { buildEnvioDte } from "./envio-dte.ts";
import {
  buildEnvioRecibos,
  buildRespuestaRecepcionEnvio,
  buildRespuestaResultadoDte,
  parseInboundEnvioDte,
} from "./intercambio.ts";
import { verifyForgeSignature } from "./xml-signature.ts";

function genCafXml(td: number): string {
  const kp = forge.pki.rsa.generateKeyPair({ bits: 512 });
  return `<?xml version="1.0"?><AUTORIZACION><CAF version="1.0"><DA>` +
    `<RE>77777777-7</RE><RS>PROVEEDOR</RS><TD>${td}</TD>` +
    `<RNG><D>1</D><H>200</H></RNG><FA>2026-06-12</FA>` +
    `<RSAPK><M>abc==</M><E>Aw==</E></RSAPK><IDK>100</IDK></DA>` +
    `<FRMA algoritmo="SHA1withRSA">deadbeef==</FRMA></CAF>` +
    `<RSASK>${forge.pki.privateKeyToPem(kp.privateKey)}</RSASK></AUTORIZACION>`;
}
function makeTestPfx(): { pfxBytes: Uint8Array; publicKey: forge.pki.rsa.PublicKey } {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [{ name: "commonName", value: "TEST" }, { name: "serialNumber", value: "22222222-2" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], "pass", { algorithm: "3des" });
  const der = forge.asn1.toDer(p12).getBytes();
  const bytes = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) bytes[i] = der.charCodeAt(i);
  return { pfxBytes: bytes, publicKey: keys.publicKey };
}

/** Sobre EnvioDTE de prueba (2 facturas 33) para usar como "recibido". */
function buildInboundSobre(pfx: Uint8Array): string {
  const cases: FacturaCertCase[] = [
    { caso: "INB-1", nroCaso: 1, tipoDocumento: 33, items: [{ nombre: "Producto A", cantidad: 10, precio: 5000 }] },
    { caso: "INB-2", nroCaso: 2, tipoDocumento: 33, items: [{ nombre: "Producto B", cantidad: 3, precio: 12000 }] },
  ];
  const args: BuildCertFacturaArgs = {
    cases,
    emisor: { rut: "77777777-7", legalName: "PROVEEDOR", giro: "Comercio", acteco: 471000, dirOrigen: "San Diego 100", cmnaOrigen: "Santiago" },
    receptor: { rut: "78416626-0", razonSocial: "COMUNIDAD RURAL SPA", giro: "Servicios", dirRecep: "Martinez 3550", cmnaRecep: "Quinta Normal" },
    firstFolioByType: { 33: 1 },
    cafByType: { 33: genCafXml(33) },
    fechaEmision: "2026-06-14",
    tstedIso: "2026-06-14T12:00:00",
  };
  const dtes = buildCertFacturaDtes(args, pfx, "pass");
  return buildEnvioDte({
    setId: "SetInbound",
    signedDtes: dtes.map((d) => d.signedDte),
    caratula: { rutEmisor: "77777777-7", rutEnvia: "22222222-2", rutReceptor: "78416626-0", fchResol: "2026-06-14", nroResol: 0, tmstFirmaEnv: "2026-06-14T12:00:00" },
    pfxBytes: pfx,
    password: "pass",
  }).xml;
}

const IDENT = {
  rutResponde: "78416626-0",
  rutRecibe: "77777777-7",
  nmbContacto: "Contacto",
  mailContacto: "contacto@example.cl",
  tmstFirma: "2026-06-14T12:30:00",
};

Deno.test("parseInboundEnvioDte: extrae setId, DTEs (tipo/folio/fecha/ruts/total) y digest", () => {
  const { pfxBytes } = makeTestPfx();
  const inbound = parseInboundEnvioDte(buildInboundSobre(pfxBytes), { nmbEnvio: "recibido.xml" });
  assertEquals(inbound.setId, "SetInbound");
  assertEquals(inbound.rutEmisor, "77777777-7");
  assertEquals(inbound.rutReceptor, "78416626-0");
  assert(inbound.digest && inbound.digest.length > 0, "debe extraer el digest del SetDTE");
  assertEquals(inbound.dtes.length, 2);
  assertEquals(inbound.dtes[0], { tipoDte: 33, folio: 1, fchEmis: "2026-06-14", rutEmisor: "77777777-7", rutRecep: "78416626-0", mntTotal: Math.round(10 * 5000 * 1.19) });
  assertEquals(inbound.dtes[1].mntTotal, Math.round(3 * 12000 * 1.19));
});

Deno.test("buildRespuestaRecepcionEnvio: acuse conforme (EstadoRecepEnv 0) + RecepcionDTE por DTE + firma verifica", () => {
  const { pfxBytes, publicKey } = makeTestPfx();
  const inbound = parseInboundEnvioDte(buildInboundSobre(pfxBytes));
  const { xml } = buildRespuestaRecepcionEnvio(inbound, IDENT, pfxBytes, "pass");
  const flat = xml.replace(/\r\n/g, "");
  assertStringIncludes(flat, `xsi:schemaLocation="http://www.sii.cl/SiiDte RespuestaEnvioDTE_v10.xsd"`);
  assertStringIncludes(flat, `<RutResponde>78416626-0</RutResponde><RutRecibe>77777777-7</RutRecibe>`);
  assertStringIncludes(flat, `<EstadoRecepEnv>0</EstadoRecepEnv>`);
  // 2 RecepcionDTE con FchEmis tras Folio (orden XSD) + EstadoRecepDTE 0
  assertEquals((flat.match(/<RecepcionDTE>/g) ?? []).length, 2);
  assertStringIncludes(flat, `<TipoDTE>33</TipoDTE><Folio>1</Folio><FchEmis>2026-06-14</FchEmis><RUTEmisor>77777777-7</RUTEmisor>`);
  assertStringIncludes(flat, `<EstadoRecepDTE>0</EstadoRecepDTE>`);
  assert(verifyForgeSignature(xml, publicKey), "la firma del Resultado debe verificar");
});

Deno.test("buildRespuestaResultadoDte: resultado comercial — acepta (0) y rechaza (2)", () => {
  const { pfxBytes, publicKey } = makeTestPfx();
  const inbound = parseInboundEnvioDte(buildInboundSobre(pfxBytes));
  const items = [
    { ...inbound.dtes[0], estado: "0", glosa: "DTE Aceptado OK" },
    { ...inbound.dtes[1], estado: "2", glosa: "Monto no coincide" },
  ];
  const { xml } = buildRespuestaResultadoDte(items, IDENT, pfxBytes, "pass");
  const flat = xml.replace(/\r\n/g, "");
  assertEquals((flat.match(/<ResultadoDTE>/g) ?? []).length, 2);
  assertStringIncludes(flat, `<EstadoDTE>0</EstadoDTE><EstadoDTEGlosa>DTE Aceptado OK</EstadoDTEGlosa>`);
  assertStringIncludes(flat, `<EstadoDTE>2</EstadoDTE><EstadoDTEGlosa>Monto no coincide</EstadoDTEGlosa>`);
  assert(verifyForgeSignature(xml, publicKey), "la firma del Resultado debe verificar");
});

Deno.test("buildEnvioRecibos: un Recibo por DTE + Declaración Ley 19.983 fija + SetRecibos firma", () => {
  const { pfxBytes, publicKey } = makeTestPfx();
  const inbound = parseInboundEnvioDte(buildInboundSobre(pfxBytes));
  const { xml } = buildEnvioRecibos(inbound.dtes, IDENT, pfxBytes, "pass", { recinto: "Bodega Central" });
  const flat = xml.replace(/\r\n/g, "");
  assertStringIncludes(flat, `xsi:schemaLocation="http://www.sii.cl/SiiDte EnvioRecibos_v10.xsd"`);
  assertEquals((flat.match(/<DocumentoRecibo /g) ?? []).length, 2);
  assertStringIncludes(flat, "letra b) del Art. 4, y la letra c) del Art. 5 de la Ley 19.983");
  assertStringIncludes(flat, `<Recinto>Bodega Central</Recinto>`);
  assertStringIncludes(flat, `<TipoDoc>33</TipoDoc><Folio>1</Folio><FchEmis>2026-06-14</FchEmis>`);
  // La firma del SetRecibos (la externa) debe verificar.
  assert(verifyForgeSignature(xml, publicKey), "la firma del SetRecibos debe verificar");
});
