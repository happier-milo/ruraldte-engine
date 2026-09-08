// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// aec.test.ts — estructura del AEC + conformidad XSD (xmllint, guardado si no está).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import forge from "npm:node-forge@1.3.1";
import { buildCertFacturaDtes, type BuildCertFacturaArgs, type FacturaCertCase } from "./cert-factura.ts";
import { buildAEC, type BuildAecInput } from "./aec.ts";

function genCafXml(tipoDte: number): string {
  const kp = forge.pki.rsa.generateKeyPair({ bits: 512 });
  let mHex = kp.publicKey.n.toString(16);
  if (mHex.length % 2) mHex = "0" + mHex;
  const M = forge.util.encode64(forge.util.hexToBytes(mHex));
  const FRMA = forge.util.encode64("firma-caf-dummy-no-criptografica-para-test");
  return (
    `<?xml version="1.0"?><AUTORIZACION><CAF version="1.0"><DA>` +
    `<RE>77777777-7</RE><RS>PROVEEDOR</RS><TD>${tipoDte}</TD>` +
    `<RNG><D>1</D><H>50</H></RNG><FA>2026-06-12</FA>` +
    `<RSAPK><M>${M}</M><E>AQAB</E></RSAPK><IDK>100</IDK></DA>` +
    `<FRMA algoritmo="SHA1withRSA">${FRMA}</FRMA></CAF>` +
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
  const attrs = [{ name: "commonName", value: "TEST" }, { name: "serialNumber", value: "22222222-2" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], "pass", { algorithm: "3des" });
  const der = forge.asn1.toDer(p12).getBytes();
  const bytes = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) bytes[i] = der.charCodeAt(i);
  return bytes;
}

function sampleSignedDte(pfx: Uint8Array): string {
  const cases: FacturaCertCase[] = [
    { caso: "CED-1", nroCaso: 1, tipoDocumento: 33, items: [{ nombre: "Servicio", cantidad: 1, precio: 100000 }] },
  ];
  const args: BuildCertFacturaArgs = {
    cases,
    emisor: { rut: "77777777-7", legalName: "PROVEEDOR", giro: "Comercio", acteco: 471000, dirOrigen: "San Diego 100", cmnaOrigen: "Santiago" },
    receptor: { rut: "55555555-5", razonSocial: "DEUDOR SA", giro: "Comercio", dirRecep: "Calle 1", cmnaRecep: "Santiago" },
    firstFolioByType: { 33: 1 },
    cafByType: { 33: genCafXml(33) },
    fechaEmision: "2026-06-14",
    tstedIso: "2026-06-14T12:00:00",
  };
  return buildCertFacturaDtes(args, pfx, "pass")[0].signedDte;
}

function sampleInput(pfx: Uint8Array): BuildAecInput {
  return {
    dteXml: sampleSignedDte(pfx),
    idDte: { tipoDte: 33, rutEmisor: "77777777-7", rutReceptor: "55555555-5", folio: 1, fchEmis: "2026-06-14", mntTotal: 119000 },
    cedente: {
      rut: "77777777-7", razonSocial: "PROVEEDOR SPA", direccion: "San Diego 100", email: "pagos@proveedor.cl",
      autorizados: [{ rut: "22222222-2", nombre: "Juan Perez" }],
    },
    cesionario: { rut: "76543210-9", razonSocial: "FACTORING SA", direccion: "Apoquindo 3000", email: "ops@factoring.cl" },
    montoCesion: 119000,
    ultimoVencimiento: "2026-07-14",
    emailDeudor: "tesoreria@deudor.cl",
    seqCesion: 1,
    tmstFirma: "2026-06-14T12:30:00",
    pfxBytes: pfx,
    password: "pass",
  };
}

Deno.test("buildAEC: estructura conforme (AEC/DocumentoAEC/Caratula/Cesiones) + 3 firmas", () => {
  const pfx = makeTestPfx();
  const { xml } = buildAEC(sampleInput(pfx));

  assertStringIncludes(xml, '<AEC xmlns="http://www.sii.cl/SiiDte"');
  assertStringIncludes(xml, 'version="1.0"');
  assertStringIncludes(xml, '<DocumentoAEC ID="RuralDTE_AEC">');
  // Carátula con sus campos obligatorios.
  assertStringIncludes(xml, "<Caratula version=\"1.0\">");
  assertStringIncludes(xml, "<RutCedente>77777777-7</RutCedente>");
  assertStringIncludes(xml, "<RutCesionario>76543210-9</RutCesionario>");
  assertStringIncludes(xml, "<TmstFirmaEnvio>2026-06-14T12:30:00</TmstFirmaEnvio>");
  // Cesiones: DTECedido PRIMERO, luego Cesion.
  const cesiones = xml.indexOf("<Cesiones>");
  const dteCedido = xml.indexOf("<DTECedido");
  const cesion = xml.indexOf("<Cesion ");
  assert(cesiones > 0 && dteCedido > cesiones && cesion > dteCedido, "orden Cesiones > DTECedido > Cesion");
  // IdDTE con RUTReceptor (obligatorio).
  assertStringIncludes(xml, "<IdDTE>");
  assertStringIncludes(xml, "<RUTReceptor>55555555-5</RUTReceptor>");
  assertStringIncludes(xml, "<RUTAutorizado><RUT>22222222-2</RUT><Nombre>Juan Perez</Nombre></RUTAutorizado>");
  assertStringIncludes(xml, "<MontoCesion>119000</MontoCesion>");
  // DTE original embebido.
  assertStringIncludes(xml, "<DTECedido");
  assert(xml.includes("<DTE") && xml.includes("</DTE>"), "DTE embebido");
  // TRES firmas (DocumentoDTECedido, DocumentoCesion, DocumentoAEC).
  const sigs = xml.match(/<Signature[\s>]/g) ?? [];
  assert(sigs.length >= 3, `esperaba ≥3 firmas, hubo ${sigs.length}`);
});

Deno.test("buildAEC: exige al menos un RUTAutorizado", () => {
  const pfx = makeTestPfx();
  const input = sampleInput(pfx);
  input.cedente.autorizados = [];
  let threw = false;
  try {
    buildAEC(input);
  } catch {
    threw = true;
  }
  assert(threw, "debe lanzar sin autorizados");
});

// ── Conformidad XSD (xmllint) — se saltea si xmllint no está instalado ───────
async function hasXmllint(): Promise<boolean> {
  try {
    const { success } = await new Deno.Command("xmllint", { args: ["--version"], stdout: "null", stderr: "null" }).output();
    return success;
  } catch {
    return false;
  }
}

Deno.test({
  name: "buildAEC: conforme a AEC_v10.xsd (xmllint)",
  ignore: !(await hasXmllint()),
  fn: async () => {
    const pfx = makeTestPfx();
    const { bytes } = buildAEC(sampleInput(pfx)); // ISO-8859-1, como lo recibe el SII
    const tmp = await Deno.makeTempFile({ suffix: ".xml" });
    await Deno.writeFile(tmp, bytes);
    const xsdPath = new URL("./xsd/AEC_v10.xsd", import.meta.url).pathname;
    const { code, stderr } = await new Deno.Command("xmllint", {
      args: ["--noout", "--schema", xsdPath, tmp],
      stdout: "null",
      stderr: "piped",
    }).output();
    await Deno.remove(tmp);
    const err = new TextDecoder().decode(stderr);
    assert(code === 0, `xmllint reprobó el AEC contra AEC_v10.xsd:\n${err}`);
  },
});

import { extractDte, getEstEnvioAec } from "./aec.ts";

Deno.test("extractDte: sobre multi-DTE → selecciona el del folio pedido (no greedy)", () => {
  const xml = `<?xml version="1.0"?><EnvioDTE><SetDTE>` +
    `<DTE version="1.0"><Documento ID="D1"><Encabezado><IdDoc><Folio>10</Folio></IdDoc></Encabezado></Documento></DTE>` +
    `<DTE version="1.0"><Documento ID="D2"><Encabezado><IdDoc><Folio>20</Folio></IdDoc></Encabezado></Documento></DTE>` +
    `</SetDTE></EnvioDTE>`;
  const d = extractDte(xml, 20);
  // Debe traer SOLO el DTE del folio 20, no ambos concatenados.
  assertEquals((d.match(/<DTE\b/g) || []).length, 1);
  assert(d.includes("<Folio>20</Folio>"));
  assert(!d.includes("<Folio>10</Folio>"));
});

Deno.test("extractDte: un solo DTE → lo devuelve; multi sin folio → lanza", () => {
  const one = `<DTE version="1.0"><Documento ID="D1"><Folio>5</Folio></Documento></DTE>`;
  assertEquals(extractDte(one), one);
  const two = `<DTE><Folio>1</Folio></DTE><DTE><Folio>2</Folio></DTE>`;
  let threw = false;
  try { extractDte(two); } catch { threw = true; }
  assert(threw, "multi-DTE sin folio debe lanzar");
});

Deno.test("getEstEnvioAec: SOAP alineado (Cookie TOKEN + DefaultNamespace) + parsea ESTADO namespaced", async () => {
  let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
  const fetchFn = ((url: string | URL, init?: RequestInit) => {
    captured = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? "") };
    const soap = `<soapenv:Envelope><soapenv:Body><ns:getEstEnvioResponse><getEstEnvioReturn>` +
      `&lt;SII:RESP_HDR&gt;&lt;SII:ESTADO&gt;0&lt;/SII:ESTADO&gt;&lt;SII:GLOSA&gt;EnvioCorrecto&lt;/SII:GLOSA&gt;&lt;/SII:RESP_HDR&gt;` +
      `</getEstEnvioReturn></ns:getEstEnvioResponse></soapenv:Body></soapenv:Envelope>`;
    return Promise.resolve(new Response(soap));
  }) as unknown as typeof fetch;
  const st = await getEstEnvioAec("cert", { token: "tk-123", trackId: "0000038936", fetchFn });
  assert(captured!.url.includes("/DTEWS/services/wsRPETCConsulta"));
  assertEquals((captured!.headers as Record<string, string>)["Cookie"], "TOKEN=tk-123");
  assert(captured!.body.includes('xmlns="http://DefaultNamespace"'));
  assert(captured!.body.includes("<TrackId"));
  assertEquals(st.estado, "0"); // parseó <SII:ESTADO> con prefijo namespaced
  assertEquals(st.glosa, "EnvioCorrecto");
});
