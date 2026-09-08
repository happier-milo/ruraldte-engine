// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// xsd-conformance.test.ts — valida el EnvioDTE generado por el motor contra los
// XSD OFICIALES v2.5 del SII (Anexo Técnico v2.5 / Res. Ex. 154/2025, XSD con
// "Fecha Actualizacion 06/02/2026", vendorizados en ./xsd/).
//
// Convierte el "verificado vs XSD con xmllint" manual del dev en un test
// repetible: arma 33/34/56/61 firmados → buildEnvioDte → escribe los BYTES
// ISO-8859-1 reales (los que recibe el SII) → `xmllint --schema EnvioDTE_v10.xsd`.
// EnvioDTE_v10.xsd hace <xs:include> de DTE_v10.xsd (v2.5) + SiiTypes_v10.xsd, así
// que un envío válido prueba conformidad de TODO el documento, con los namespaces
// correctos (el <DTE> hereda xmlns del sobre).
//
// Se SALTEA (ignore) si xmllint no está instalado, para no romper en máquinas/CI
// sin libxml. Localmente: `xmllint --version`.
// ============================================================================

import { assert } from "jsr:@std/assert@1";
import forge from "npm:node-forge@1.3.1";
import { buildSignedFacturaDte, type FacturaDteInput } from "./factura-dte.ts";
import { buildEnvioDte } from "./envio-dte.ts";

// ── helpers de prueba (cert self-signed + CAF dummy), espejo de factura-dte.test ─
function genCafXml(tipoDte: number): string {
  const kp = forge.pki.rsa.generateKeyPair({ bits: 512 });
  // M/E/FRMA deben ser xs:base64Binary VÁLIDOS (el XSD lo exige). M = módulo real
  // de la llave; FRMA = base64 válido cualquiera (la firma SII del CAF no se verifica
  // al construir el DTE, solo debe tener formato base64).
  let mHex = kp.publicKey.n.toString(16);
  if (mHex.length % 2) mHex = "0" + mHex;
  const M = forge.util.encode64(forge.util.hexToBytes(mHex));
  const FRMA = forge.util.encode64("firma-caf-dummy-no-criptografica-para-test");
  return (
    `<?xml version="1.0"?><AUTORIZACION><CAF version="1.0"><DA>` +
    `<RE>78416626-0</RE><RS>COMUNIDAD RURAL SPA</RS><TD>${tipoDte}</TD>` +
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

const EMISOR = {
  rut: "78416626-0",
  razonSocial: "COMUNIDAD RURAL SPA",
  giro: "PLATAFORMA SAAS Y SERVICIOS DE TECNOLOGÍA", // con acento → ejercita ISO-8859-1
  acteco: 620200,
  dirOrigen: "Martínez de Rozas 3550",
  cmnaOrigen: "Quinta Normal",
  ciudadOrigen: "Santiago",
};
const RECEPTOR = {
  rut: "77777777-7",
  razonSocial: "EMPRESA LTDA",
  giro: "COMPUTACION",
  dirRecep: "SAN DIEGO 2222",
  cmnaRecep: "LA FLORIDA",
  ciudadRecep: "SANTIAGO",
};

function afecta(folio: number): FacturaDteInput {
  return {
    tipoDte: 33,
    folio,
    fechaEmision: "2026-06-12",
    formaPago: 1,
    emisor: EMISOR,
    receptor: RECEPTOR,
    items: [{ nombre: "Parlantes", cantidad: 2, precio: 45000 }, { nombre: "Mouse", cantidad: 1, precio: 10000 }],
    totals: { neto: 100000, iva: 19000, exento: 0, total: 119000 },
    cafXml: genCafXml(33),
    tstedIso: "2026-06-12T09:33:20",
    tmstFirma: "2026-06-12T09:33:20",
    documentId: "F33T100",
  };
}

// latin1: el EnvioDTE se declara ISO-8859-1; escribimos los bytes reales (no UTF-8)
// para que xmllint lea correctamente los acentos y valide lo que recibe el SII.
function toLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

async function hasXmllint(): Promise<boolean> {
  try {
    const { success } = await new Deno.Command("xmllint", { args: ["--version"], stdout: "null", stderr: "null" })
      .output();
    return success;
  } catch {
    return false;
  }
}

const HAS_XMLLINT = await hasXmllint();

Deno.test({
  name: "EnvioDTE (33/34/56/61 firmados) valida contra los XSD v2.5 del SII",
  ignore: !HAS_XMLLINT,
  fn: async () => {
    const pfx = makeTestPfx();

    const f33 = afecta(100);
    const f34: FacturaDteInput = {
      ...afecta(101),
      tipoDte: 34,
      items: [{ nombre: "Servicio exento", cantidad: 1, precio: 50000, exento: true }],
      totals: { neto: 0, iva: 0, exento: 50000, total: 50000 },
      cafXml: genCafXml(34),
      documentId: "F34T101",
    };
    const nc61: FacturaDteInput = {
      ...afecta(200),
      tipoDte: 61,
      cafXml: genCafXml(61),
      documentId: "F61T200",
      referencias: [{ tipoDocRef: "33", folioRef: 100, fchRef: "2026-06-12", codRef: 1, razonRef: "Anula" }],
    };
    const nd56: FacturaDteInput = {
      ...afecta(300),
      tipoDte: 56,
      cafXml: genCafXml(56),
      documentId: "F56T300",
      referencias: [{ tipoDocRef: "33", folioRef: 100, fchRef: "2026-06-12", codRef: 3, razonRef: "Corrige monto" }],
    };

    const { xml } = buildEnvioDte({
      setId: "SET_CONFORMANCE",
      signedDtes: [
        buildSignedFacturaDte(f33, pfx, "pass"),
        buildSignedFacturaDte(f34, pfx, "pass"),
        buildSignedFacturaDte(nc61, pfx, "pass"),
        buildSignedFacturaDte(nd56, pfx, "pass"),
      ],
      caratula: {
        rutEmisor: "78416626-0",
        rutEnvia: "22222222-2",
        rutReceptor: "60803000-K",
        fchResol: "2026-06-08",
        nroResol: 0,
        tmstFirmaEnv: "2026-06-12T22:11:10",
      },
      pfxBytes: pfx,
      password: "pass",
    });

    const xmlPath = await Deno.makeTempFile({ prefix: "ruraldte_envio_", suffix: ".xml" });
    const xsdPath = new URL("./xsd/EnvioDTE_v10.xsd", import.meta.url).pathname;
    try {
      await Deno.writeFile(xmlPath, toLatin1(xml));
      const { code, stderr } = await new Deno.Command("xmllint", {
        args: ["--noout", "--schema", xsdPath, xmlPath],
        stdout: "null",
        stderr: "piped",
      }).output();
      const err = new TextDecoder().decode(stderr);
      assert(code === 0, `xmllint reprobó el EnvioDTE contra el XSD v2.5:\n${err}`);
    } finally {
      await Deno.remove(xmlPath).catch(() => {});
    }
  },
});
