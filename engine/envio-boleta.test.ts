// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// envio-boleta.test.ts — valida buildEnvioBoleta: estructura + propiedad central
// "firmar lo que se serializa" (el digest del SetDTE recomputado sobre los BYTES
// emitidos == el firmado) + la firma del SET verifica con C14N inclusiva real.
// ============================================================================

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import forge from "npm:node-forge@1.3.1";
import { type BoletaDteInput, buildSignedBoletaDte } from "./boleta-dte.ts";
import { buildEnvioBoleta } from "./envio-boleta.ts";
import { canonicalize, parseXml } from "./c14n.ts";

function genCafXml(): string {
  const kp = forge.pki.rsa.generateKeyPair({ bits: 512 });
  return (
    `<?xml version="1.0"?><AUTORIZACION><CAF version="1.0"><DA>` +
    `<RE>78416626-0</RE><RS>COMUNIDAD RURAL SPA</RS><TD>39</TD>` +
    `<RNG><D>1</D><H>5</H></RNG><FA>2026-06-08</FA>` +
    `<RSAPK><M>abc==</M><E>Aw==</E></RSAPK><IDK>100</IDK></DA>` +
    `<FRMA algoritmo="SHA1withRSA">deadbeef==</FRMA></CAF>` +
    `<RSASK>${forge.pki.privateKeyToPem(kp.privateKey)}</RSASK></AUTORIZACION>`
  );
}

function makeTestPfx(): { pfxBytes: Uint8Array; publicKey: forge.pki.rsa.PublicKey } {
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
  return { pfxBytes: bytes, publicKey: keys.publicKey };
}

function dteInput(folio: number, total: number, cafXml: string): BoletaDteInput {
  const neto = Math.round(total / 1.19);
  return {
    tipoDte: 39,
    folio,
    fechaEmision: "2026-06-08",
    indServicio: 3,
    emisor: {
      rut: "78416626-0",
      razonSocial: "COMUNIDAD RURAL SPA",
      giro: "PLATAFORMA SAAS Y SERVICIOS DE TECNOLOGÍA INFORMÁTICA",
      dirOrigen: "Martínez de Rozas 3550, Piso 18, Depto 1808",
      cmnaOrigen: "Quinta Normal",
    },
    receptor: { rut: "66666666-6", razonSocial: "Set de pruebas SII" },
    items: [{ nombre: "Item afecto", cantidad: 1, precio: total }],
    totals: { neto, iva: total - neto, exento: 0, total },
    referencia: { tipoDocRef: "SET", folioRef: folio, codRef: "SET", razonRef: `CASO-${folio}` },
    cafXml,
    tstedIso: "2026-06-08T18:24:11",
    tmstFirma: "2026-06-08T18:24:11",
    documentId: `T_TEST_${folio}`,
  };
}

function sha1Utf8B64(s: string): string {
  const md = forge.md.sha1.create();
  md.update(s, "utf8");
  return forge.util.encode64(md.digest().getBytes());
}

// deno-lint-ignore no-explicit-any
function setSignedInfoOf(doc: any): any {
  const sigs = doc.getElementsByTagName("Signature");
  for (let i = 0; i < sigs.length; i++) {
    if (sigs[i].parentNode && sigs[i].parentNode.nodeName === "EnvioBOLETA") {
      return sigs[i].getElementsByTagName("SignedInfo")[0];
    }
  }
  throw new Error("firma del SET no encontrada");
}

Deno.test("buildEnvioBoleta: estructura del sobre (carátula, SubTotDTE, firma del SET)", () => {
  const { pfxBytes } = makeTestPfx();
  const caf = genCafXml();
  const dtes = [
    buildSignedBoletaDte(dteInput(1, 29800, caf), pfxBytes, "pass"),
    buildSignedBoletaDte(dteInput(2, 2040, caf), pfxBytes, "pass"),
  ];
  const { xml } = buildEnvioBoleta({
    setId: "ENVIOBOLETA_TEST",
    signedDtes: dtes,
    caratula: {
      rutEmisor: "78416626-0",
      rutEnvia: "22222222-2",
      rutReceptor: "60803000-K",
      fchResol: "2014-08-22",
      nroResol: 0,
      tmstFirmaEnv: "2026-06-08T22:11:10",
    },
    pfxBytes,
    password: "pass",
  });

  assert(xml.startsWith(`<?xml version="1.0" encoding="ISO-8859-1"?>`));
  assertStringIncludes(xml, `<EnvioBOLETA xmlns:xsi=`);
  assertStringIncludes(xml, `xmlns="http://www.sii.cl/SiiDte">`);
  assertStringIncludes(xml, `<SetDTE ID="ENVIOBOLETA_TEST">`);
  // carátula
  assertStringIncludes(xml, `<RutEmisor>78416626-0</RutEmisor>`);
  assertStringIncludes(xml, `<RutEnvia>22222222-2</RutEnvia>`);
  assertStringIncludes(xml, `<RutReceptor>60803000-K</RutReceptor>`);
  // SubTotDTE: 2 boletas tipo 39
  assertStringIncludes(
    xml,
    `<SubTotDTE>\r\n<TpoDTE>39</TpoDTE>\r\n<NroDTE>2</NroDTE>\r\n</SubTotDTE>`,
  );
  // los 2 DTE incrustados verbatim + firma del SET al final
  assert(xml.includes(`<Documento ID="T_TEST_1">`) && xml.includes(`<Documento ID="T_TEST_2">`));
  assert(xml.endsWith(`</Signature></EnvioBOLETA>`));
  assertStringIncludes(xml, `<Reference URI="#ENVIOBOLETA_TEST">`);
});

Deno.test("buildEnvioBoleta: firmar-lo-que-serializo — digest del SetDTE recomputado == firmado", () => {
  const { pfxBytes } = makeTestPfx();
  const caf = genCafXml();
  const dtes = [buildSignedBoletaDte(dteInput(1, 29800, caf), pfxBytes, "pass")];
  const { xml, setDigest } = buildEnvioBoleta({
    setId: "SOBRE_1",
    signedDtes: dtes,
    caratula: {
      rutEmisor: "78416626-0",
      rutEnvia: "22222222-2",
      rutReceptor: "60803000-K",
      fchResol: "2014-08-22",
      nroResol: 0,
      tmstFirmaEnv: "2026-06-08T22:11:10",
    },
    pfxBytes,
    password: "pass",
  });

  // Recanonicalizar el SetDTE sobre los BYTES EMITIDOS (lo que hará el SII).
  const doc = parseXml(xml);
  const setEl = doc.getElementsByTagName("SetDTE")[0];
  const recomputed = sha1Utf8B64(canonicalize(setEl));

  // El digest emitido en el SignedInfo del SET:
  const si = setSignedInfoOf(doc);
  const digestInSI = si.getElementsByTagName("DigestValue")[0].textContent.replace(/\s/g, "");

  assertEquals(
    recomputed,
    setDigest,
    "el digest recomputado sobre la salida debe igualar el reportado",
  );
  assertEquals(
    digestInSI,
    setDigest,
    "el DigestValue del SignedInfo debe ser el del SetDTE emitido",
  );
});

Deno.test("buildEnvioBoleta: la firma del SET verifica (RSA-SHA1 sobre C14N real del SignedInfo)", () => {
  const { pfxBytes, publicKey } = makeTestPfx();
  const caf = genCafXml();
  const dtes = [
    buildSignedBoletaDte(dteInput(1, 29800, caf), pfxBytes, "pass"),
    buildSignedBoletaDte(dteInput(2, 2040, caf), pfxBytes, "pass"),
  ];
  const { xml } = buildEnvioBoleta({
    setId: "SOBRE_X",
    signedDtes: dtes,
    caratula: {
      rutEmisor: "78416626-0",
      rutEnvia: "22222222-2",
      rutReceptor: "60803000-K",
      fchResol: "2014-08-22",
      nroResol: 0,
      tmstFirmaEnv: "2026-06-08T22:11:10",
    },
    pfxBytes,
    password: "pass",
  });

  const doc = parseXml(xml);
  const si = setSignedInfoOf(doc);
  const siC14n = canonicalize(si);
  // in-envelope → el SignedInfo hereda xmldsig# + xsi (namespaces mixtos)
  assertStringIncludes(siC14n, `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`);

  const sigVal = doc.getElementsByTagName("Signature");
  let setSig = null;
  for (let i = 0; i < sigVal.length; i++) {
    if (sigVal[i].parentNode.nodeName === "EnvioBOLETA") {
      setSig = sigVal[i];
      break;
    }
  }
  const sv = setSig.getElementsByTagName("SignatureValue")[0].textContent.replace(/\s/g, "");
  const md = forge.md.sha1.create();
  md.update(siC14n, "utf8");
  assert(
    publicKey.verify(md.digest().getBytes(), forge.util.decode64(sv)),
    "la firma del SET debe verificar sobre nuestra C14N(SignedInfo)",
  );
});
