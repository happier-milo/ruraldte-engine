// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// rsa-firma.test.ts — la firma nativa da los MISMOS bytes que la de node-forge, y
// el firmador nunca entrega una firma que forge no habría dado.
// ============================================================================

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import forge from "npm:node-forge@1.3.1";
import process from "node:process";
import {
  crearFirmador,
  estadoFirmaNativa,
  type FirmaRsaSha1,
  firmarConForge,
  firmarConNodeCrypto,
  firmarRsaSha1,
} from "./rsa-firma.ts";
import { type BoletaDteInput, buildSignedBoletaDte } from "./boleta-dte.ts";
import { buildEnvioBoleta } from "./envio-boleta.ts";
import { canonicalize, parseXml } from "./c14n.ts";

const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

function clave(bits: number): { pkcs1: string; pkcs8: string; key: forge.pki.rsa.KeyPair } {
  const key = forge.pki.rsa.generateKeyPair({ bits, e: 0x10001 });
  return {
    key,
    // Lo que entrega extractPemFromPkcs12 (privateKeyToPem → "RSA PRIVATE KEY").
    pkcs1: forge.pki.privateKeyToPem(key.privateKey),
    pkcs8: forge.pki.privateKeyInfoToPem(
      forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(key.privateKey)),
    ),
  };
}

// Textos como los que se firman de verdad: el SignedInfo canónico, con y sin
// caracteres fuera de ASCII (el digest XMLDSig va sobre UTF-8), corto y largo.
const TEXTOS = [
  `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></CanonicalizationMethod><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod><Reference URI="#F1024T41"><Transforms><Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></Transform></Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod><DigestValue>2jmj7l5rSw0yVb/vlWAYkK/YBwk=</DigestValue></Reference></SignedInfo>`,
  "COMITÉ DE AGUA POTABLE RURAL ÑUÑOA Y PEÑAFLOR — año 2026",
  "",
  "a",
  "x".repeat(20_000),
];

Deno.test("la firma nativa es byte a byte la de node-forge (2048 y 1024 bits, PKCS#1 y PKCS#8)", () => {
  for (const bits of [2048, 1024]) {
    const { pkcs1, pkcs8 } = clave(bits);
    for (const texto of TEXTOS) {
      const forgeFirma = firmarConForge(pkcs1, texto);
      assertEquals(firmarConNodeCrypto(pkcs1, texto), forgeFirma, `${bits} bits, PKCS#1`);
      assertEquals(firmarConNodeCrypto(pkcs8, texto), forgeFirma, `${bits} bits, PKCS#8`);
    }
  }
});

Deno.test("la firma nativa verifica con la clave pública (no solo coincide con forge)", () => {
  const { pkcs1, key } = clave(2048);
  const texto = TEXTOS[0];
  const md = forge.md.sha1.create();
  md.update(texto, "utf8");
  assert(key.publicKey.verify(md.digest().getBytes(), forge.util.decode64(firmarRsaSha1(pkcs1, texto))));
});

/** Doble que cuenta cuántas veces lo llaman. */
function contado(fn: FirmaRsaSha1): { fn: FirmaRsaSha1; veces: () => number } {
  let n = 0;
  return {
    fn: (pem, texto) => {
      n++;
      return fn(pem, texto);
    },
    veces: () => n,
  };
}

Deno.test("firmador: comprueba la nativa una vez por clave y después no vuelve a llamar a forge", () => {
  const nativa = contado((pem, t) => `firma(${pem}|${t})`);
  const referencia = contado((pem, t) => `firma(${pem}|${t})`);
  const f = crearFirmador(nativa.fn, referencia.fn);
  assertEquals(f.estado(), { estado: "sin_usar" });

  for (let i = 0; i < 5; i++) assertEquals(f.firmar("clave-A", `t${i}`), `firma(clave-A|t${i})`);
  assertEquals(f.estado(), { estado: "comprobada" });
  assertEquals(nativa.veces(), 5);
  assertEquals(referencia.veces(), 1, "forge solo en la primera firma de la clave");

  // Otra clave se comprueba de nuevo: la coincidencia de una no dice nada de la otra.
  f.firmar("clave-B", "t");
  f.firmar("clave-B", "t2");
  assertEquals(referencia.veces(), 2);
});

Deno.test("firmador: si la nativa da otra firma, entrega la de forge y no la usa más", () => {
  const nativa = contado(() => "FIRMA-DISTINTA");
  const referencia = contado((pem, t) => `forge(${pem}|${t})`);
  const f = crearFirmador(nativa.fn, referencia.fn);

  assertEquals(f.firmar("clave-A", "t0"), "forge(clave-A|t0)");
  const estado = f.estado();
  assertEquals(estado.estado, "descartada");
  assert(estado.estado === "descartada" && estado.motivo.includes("no coincide"));

  assertEquals(f.firmar("clave-A", "t1"), "forge(clave-A|t1)");
  assertEquals(f.firmar("clave-B", "t2"), "forge(clave-B|t2)");
  assertEquals(nativa.veces(), 1, "descartada para todas las claves: el defecto es del runtime");
});

Deno.test("firmador: si la nativa lanza, entrega la de forge y dice por qué", () => {
  const f = crearFirmador(
    () => {
      throw new Error("Digest method not supported");
    },
    (pem, t) => `forge(${pem}|${t})`,
  );
  assertEquals(f.firmar("clave-A", "t0"), "forge(clave-A|t0)");
  assertEquals(f.estado(), {
    estado: "descartada",
    motivo: "la firma nativa falló: Digest method not supported",
  });
});

Deno.test("firmador: una nativa que falla DESPUÉS de comprobada también cae a forge", () => {
  let falla = false;
  const f = crearFirmador(
    (pem, t) => {
      if (falla) throw new Error("se rompió");
      return `firma(${pem}|${t})`;
    },
    (pem, t) => `firma(${pem}|${t})`,
  );
  f.firmar("clave-A", "t0");
  assertEquals(f.estado(), { estado: "comprobada" });
  falla = true;
  assertEquals(f.firmar("clave-A", "t1"), "firma(clave-A|t1)");
  assertEquals(f.estado().estado, "descartada");
});

// ── Lo mismo, a través del motor ────────────────────────────────────────────

function genCafXml(): string {
  const kp = forge.pki.rsa.generateKeyPair({ bits: 512 });
  return (
    `<?xml version="1.0"?><AUTORIZACION><CAF version="1.0"><DA>` +
    `<RE>78416626-0</RE><RS>COMUNIDAD RURAL SPA</RS><TD>41</TD>` +
    `<RNG><D>1</D><H>500</H></RNG><FA>2026-06-08</FA>` +
    `<RSAPK><M>abc==</M><E>Aw==</E></RSAPK><IDK>100</IDK></DA>` +
    `<FRMA algoritmo="SHA1withRSA">deadbeef==</FRMA></CAF>` +
    `<RSASK>${forge.pki.privateKeyToPem(kp.privateKey)}</RSASK></AUTORIZACION>`
  );
}

function makePfx(): { pfxBytes: Uint8Array; pkeyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
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
  return { pfxBytes: bytes, pkeyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

function boleta(folio: number, cafXml: string): BoletaDteInput {
  const total = 8000 + folio * 10;
  return {
    tipoDte: 41,
    folio,
    fechaEmision: "2026-10-30",
    indServicio: 3,
    emisor: {
      rut: "78416626-0",
      razonSocial: "COMITÉ DE AGUA POTABLE RURAL DE PRUEBA",
      giro: "CAPTACIÓN, TRATAMIENTO Y DISTRIBUCIÓN DE AGUA",
      dirOrigen: "Camino Principal S/N",
      cmnaOrigen: "Olmué",
    },
    receptor: { rut: "12345678-5", razonSocial: `Socio ${folio} Ñandú`, dirRecep: `Parcela ${folio}` },
    items: [{ nombre: "Consumo de agua octubre", cantidad: 1, precio: total, exento: true }],
    totals: { neto: 0, iva: 0, exento: total, total },
    cafXml,
    tstedIso: "2026-10-30T10:15:00",
    tmstFirma: "2026-10-30T10:15:00",
    documentId: `F${folio}T41`,
  };
}

/** El SignedInfo de la firma del DTE, canónico y en contexto: lo que se firmó. */
function signedInfoCanonico(dteXml: string): string {
  const doc = parseXml(dteXml.slice(dteXml.indexOf("<DTE")));
  return canonicalize(doc.getElementsByTagName("SignedInfo")[0]);
}

Deno.test("buildSignedBoletaDte: el SignatureValue es el que da node-forge, y firmó la nativa", () => {
  const { pfxBytes, pkeyPem } = makePfx();
  const caf = genCafXml();
  for (const folio of [1, 2, 3]) {
    const dte = buildSignedBoletaDte(boleta(folio, caf), pfxBytes, "pass");
    const valor = dte.match(/<SignatureValue>([^<]+)<\/SignatureValue>/)?.[1];
    assertEquals(valor, firmarConForge(pkeyPem, signedInfoCanonico(dte)), `folio ${folio}`);
  }
  // Si acá dice "descartada", el motor volvió a firmar con forge: funciona, pero cada
  // boleta cuesta diez veces más CPU y un lote deja de caber en una edge function.
  assertEquals(estadoFirmaNativa(), { estado: "comprobada" });
});

Deno.test("buildEnvioBoleta: la firma del SOBRE también es la que da node-forge", () => {
  const { pfxBytes, pkeyPem } = makePfx();
  const caf = genCafXml();
  const dtes = [1, 2, 3].map((f) => buildSignedBoletaDte(boleta(f, caf), pfxBytes, "pass"));
  const { xml } = buildEnvioBoleta({
    setId: "LOTE_firma",
    signedDtes: dtes,
    caratula: {
      rutEmisor: "78416626-0",
      rutEnvia: "22222222-2",
      rutReceptor: "60803000-K",
      fchResol: "2014-08-22",
      nroResol: 0,
      tmstFirmaEnv: "2026-10-30T10:15:00",
    },
    pfxBytes,
    password: "pass",
  });
  // La firma del SET es la <Signature> hija directa de la raíz: la última del sobre.
  const doc = parseXml(xml.slice(xml.indexOf("<EnvioBOLETA")));
  const firmas = doc.getElementsByTagName("Signature");
  const delSet = firmas[firmas.length - 1];
  assertEquals(delSet.parentNode.nodeName, "EnvioBOLETA");
  const valor = delSet.getElementsByTagName("SignatureValue")[0].textContent;
  const signedInfo = canonicalize(delSet.getElementsByTagName("SignedInfo")[0]);
  assertEquals(valor, firmarConForge(pkeyPem, signedInfo));
});

// El costo se mide en CPU, no en reloj: con el equipo cargado el reloj no dice nada.
Deno.test("la firma nativa cuesta menos de la mitad de CPU que la de node-forge", () => {
  const { pkcs1 } = clave(2048);
  const texto = TEXTOS[0];
  firmarConForge(pkcs1, texto);
  firmarConNodeCrypto(pkcs1, texto);

  const N = 30;
  let a = cpuMs();
  for (let i = 0; i < N; i++) firmarConForge(pkcs1, texto + i);
  const forgeMs = cpuMs() - a;
  a = cpuMs();
  for (let i = 0; i < N; i++) firmarConNodeCrypto(pkcs1, texto + i);
  const nativaMs = cpuMs() - a;

  assertNotEquals(forgeMs, 0);
  assert(
    nativaMs * 2 < forgeMs,
    `nativa ${nativaMs.toFixed(1)} ms vs forge ${forgeMs.toFixed(1)} ms de CPU en ${N} firmas`,
  );
});
