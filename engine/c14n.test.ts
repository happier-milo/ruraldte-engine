// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// c14n.test.ts — valida la C14N inclusiva real contra datos cripto REALES del
// sobre EnvioBOLETA capturado del oráculo de calibración (oráculo aceptado por el SII).
//
// Tres pruebas que blindan la correctitud (incl. el caso de namespaces mixtos):
//   1) reproduce el DigestValue per-DTE del Documento (standalone, sin ns),
//   2) la SignatureValue per-DTE verifica RSA sobre C14N(SignedInfo) [standalone,
//      sin xsi — cada DTE se firma como documento propio antes de incrustarse],
//   3) la SignatureValue del SET verifica RSA sobre C14N(SignedInfo) [in-envelope,
//      con `xsi` heredado del root SiiDte] — el eje de namespaces inclusivo.
//
// (No se afirma reproducir el DigestValue del SET `QS3j…`: es un artefacto de
// el oráculo de calibración, que firma una serialización interna ≠ a los bytes que emite. La
// prueba 3 confirma que `QS3j` ES su digest real y que nuestra C14N del SignedInfo
// mixto es correcta — que es lo que importa para firmar nuestro propio sobre.)
// ============================================================================

import { assert, assertEquals } from "jsr:@std/assert@1";
import forge from "npm:node-forge@1.3.1";
import { canonicalize, canonicalizeElement, parseXml } from "./c14n.ts";

// ---- carga del fixture (base64 lossless → string Unicode desde latin1) ----
const b64 = (await Deno.readTextFile(
  new URL("./__fixtures__/envio-boleta-oraculo.b64", import.meta.url),
)).replace(/\s+/g, "");
const bin = forge.util.decode64(b64);
let envelopeXml = "";
for (let i = 0; i < bin.length; i++) envelopeXml += String.fromCharCode(bin.charCodeAt(i) & 0xff);
// normalización de fin de línea (igual que parseXml) para extraer substrings consistentes
const xml = envelopeXml.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

function sha1Utf8B64(s: string): string {
  const md = forge.md.sha1.create();
  md.update(s, "utf8");
  return forge.util.encode64(md.digest().getBytes());
}

// deno-lint-ignore no-explicit-any
function rsaVerify(signedInfoC14n: string, sigEl: any): boolean {
  const sigVal = sigEl.getElementsByTagName("SignatureValue")[0].textContent.replace(/\s/g, "");
  const mod = sigEl.getElementsByTagName("Modulus")[0].textContent.replace(/\s/g, "");
  const exp = sigEl.getElementsByTagName("Exponent")[0].textContent.replace(/\s/g, "");
  const n = new forge.jsbn.BigInteger(forge.util.bytesToHex(forge.util.decode64(mod)), 16);
  const e = new forge.jsbn.BigInteger(forge.util.bytesToHex(forge.util.decode64(exp)), 16);
  const pub = forge.pki.rsa.setPublicKey(n, e);
  const md = forge.md.sha1.create();
  md.update(signedInfoC14n, "utf8");
  try {
    return pub.verify(md.digest().getBytes(), forge.util.decode64(sigVal));
  } catch {
    return false;
  }
}

function extract(s: string, tag: string): string {
  const a = s.indexOf(`<${tag}`);
  const close = `</${tag}>`;
  const b = s.indexOf(close, a);
  return s.slice(a, b + close.length);
}

Deno.test("C14N: reproduce el DigestValue per-DTE del Documento (standalone, sin ns)", () => {
  const documento1 = extract(xml, "Documento"); // primer <Documento>…</Documento>
  const c14n = canonicalizeElement(documento1, "Documento");
  // sin namespace heredado: el Documento standalone no declara xmlns
  assert(!c14n.startsWith("<Documento xmlns"), "Documento standalone NO debe llevar xmlns");
  assertEquals(sha1Utf8B64(c14n), "T8aAyD8fsonDpWXKRc+uqbl+AMU=");
});

Deno.test("C14N: la firma per-DTE verifica sobre C14N(SignedInfo) standalone [sin xsi]", () => {
  // El primer <Signature xmlns=xmldsig#>…</Signature> es el del DTE #1.
  const sigXml = extract(xml, "Signature");
  const sigDoc = parseXml(sigXml); // standalone → SignedInfo hereda sólo xmldsig#, NO xsi
  const signedInfo = sigDoc.getElementsByTagName("SignedInfo")[0];
  const c14n = canonicalize(signedInfo);
  assert(
    c14n.includes(`<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">`),
    "SignedInfo standalone hereda xmldsig# y NO xsi",
  );
  assert(
    rsaVerify(c14n, sigDoc.getElementsByTagName("Signature")[0]),
    "la SignatureValue per-DTE debe verificar sobre nuestra C14N(SignedInfo) standalone",
  );
});

Deno.test("C14N: la firma del SET verifica sobre C14N(SignedInfo) in-envelope [con xsi]", () => {
  const doc = parseXml(envelopeXml);
  // la firma del SET es la <Signature> hija directa de <EnvioBOLETA> (las per-DTE están dentro de <DTE>)
  const sigs = doc.getElementsByTagName("Signature");
  let setSig = null;
  for (let i = 0; i < sigs.length; i++) {
    if (sigs[i].parentNode && sigs[i].parentNode.nodeName === "EnvioBOLETA") {
      setSig = sigs[i];
      break;
    }
  }
  assert(setSig, "debe existir la firma del SET (hija de EnvioBOLETA)");
  const signedInfo = setSig.getElementsByTagName("SignedInfo")[0];
  const c14n = canonicalize(signedInfo);
  // in-envelope: el SignedInfo hereda xmldsig# (default) + xsi (del root SiiDte) → namespaces mixtos
  assert(
    c14n.includes(`xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`),
    "SignedInfo in-envelope debe heredar y emitir xmlns:xsi (eje inclusivo)",
  );
  assert(
    rsaVerify(c14n, setSig),
    "la SignatureValue del SET debe verificar sobre nuestra C14N(SignedInfo) mixto",
  );
  // y el digest interno del SET es justamente el `QS3j…` (artefacto del oráculo, no lo reproducimos)
  const digestInSI = signedInfo.getElementsByTagName("DigestValue")[0].textContent.replace(
    /\s/g,
    "",
  );
  assertEquals(digestInSI, "QS3j+Dn7guJeIMO1mRO7uPy6xqQ=");
});

Deno.test("C14N: expande elementos vacíos y normaliza fin de línea", () => {
  const c14n = canonicalizeElement(`<a><b foo="1" /><c></c>\r\n<d>x</d></a>`, "a");
  assertEquals(c14n, `<a><b foo="1"></b><c></c>\n<d>x</d></a>`);
});

Deno.test("C14N: ordena namespaces (default primero) y atributos, elimina superfluos", () => {
  // root declara xsi+default; hijo redeclara el mismo default (superfluo) y usa atributos desordenados
  const xmlIn = `<r xmlns:xsi="urn:xsi" xmlns="urn:d"><c z="2" a="1" xmlns="urn:d"><x/></c></r>`;
  const c14n = canonicalizeElement(xmlIn, "c");
  // apex hereda default + xsi (inclusivo); el redeclare de default es superfluo → no se repite;
  // atributos ordenados a,z; <x/> expandido
  assertEquals(
    c14n,
    `<c xmlns="urn:d" xmlns:xsi="urn:xsi" a="1" z="2"><x></x></c>`,
  );
});
