// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import forge from "npm:node-forge@1.3.1";
import { extractPemFromPkcs12, Pkcs12ExtractError } from "./pkcs12.ts";
import { signSiiXml } from "./xml-signature.ts";

// .pfx de prueba (par RSA + cert self-signed con RUT en el subject SerialNumber).
function makeTestPfxBytes(password: string): Uint8Array {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [
    { name: "commonName", value: "TEST" },
    { name: "serialNumber", value: "22222222-2" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: "3des" });
  const der = forge.asn1.toDer(p12).getBytes();
  const out = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) out[i] = der.charCodeAt(i);
  return out;
}

Deno.test("extractPemFromPkcs12: .pfx válido → cert + pkey + RUT del subject", () => {
  const ex = extractPemFromPkcs12(makeTestPfxBytes("pass"), "pass");
  assertEquals(ex.rutFromCert, "22222222-2");
  assert(ex.certPem.includes("BEGIN CERTIFICATE"));
  assert(ex.pkeyPem.includes("PRIVATE KEY"));
});

// Custodia #1: validar el .pfx AL SUBIR. uploadCredential convierte estos errores
// tipados en un 422 (antes de cifrar/guardar) → el error no espera al EMIT (folio).
Deno.test("extractPemFromPkcs12: bytes basura → invalid_format", () => {
  const e = assertThrows(
    () => extractPemFromPkcs12(new Uint8Array([1, 2, 3, 4]), "x"),
    Pkcs12ExtractError,
  );
  assertEquals((e as Pkcs12ExtractError).code, "invalid_format");
});

Deno.test("extractPemFromPkcs12: password incorrecto → wrong_password", () => {
  const e = assertThrows(
    () => extractPemFromPkcs12(makeTestPfxBytes("right"), "wrong"),
    Pkcs12ExtractError,
  );
  assertEquals((e as Pkcs12ExtractError).code, "wrong_password");
});

// ── Memoización A2 (vector dorado: la caché es TRANSPARENTE) ─────────────────

Deno.test("memo A2: misma instancia + mismo password → MISMA referencia (1 solo parse)", () => {
  const bytes = makeTestPfxBytes("pass");
  const a = extractPemFromPkcs12(bytes, "pass");
  const b = extractPemFromPkcs12(bytes, "pass");
  assert(a === b, "un cache hit devuelve el mismo objeto → no re-parseó");
});

Deno.test("memo A2: instancia DISTINTA del mismo contenido → PEM deep-equal (transparente)", () => {
  // Dos arrays con los MISMOS bytes pero identidad distinta: el WeakMap no acierta
  // (miss → re-extrae). El resultado debe ser equivalente (mismas keys/cert).
  const src = makeTestPfxBytes("pass");
  const copy = src.slice();
  const a = extractPemFromPkcs12(src, "pass");
  const b = extractPemFromPkcs12(copy, "pass");
  assert(a !== b, "instancias distintas → objetos distintos");
  assertEquals(a.certPem, b.certPem);
  assertEquals(a.pkeyPem, b.pkeyPem);
  assertEquals(a.rutFromCert, b.rutFromCert);
});

Deno.test("memo A2: un error NO envenena la caché (wrong→right en la misma instancia)", () => {
  const bytes = makeTestPfxBytes("right");
  assertThrows(() => extractPemFromPkcs12(bytes, "wrong"), Pkcs12ExtractError);
  // El password correcto sobre la MISMA instancia debe funcionar (el throw no cacheó).
  const ok = extractPemFromPkcs12(bytes, "right");
  assert(ok.pkeyPem.includes("PRIVATE KEY"));
});

Deno.test("memo A2: FIRMA byte-idéntica — memoizada vs instancia fresca (regresión cripto)", () => {
  const src = makeTestPfxBytes("pass");
  const fresh = src.slice(); // mismo contenido, instancia distinta → fuerza re-extracción
  const xml = '<Root xmlns="http://www.sii.cl/SiiDte"><Doc ID="F1">contenido</Doc></Root>';
  const opts = {
    signedElementTag: "Doc",
    signedElementId: "F1",
    signedElementNs: "http://www.sii.cl/SiiDte",
    password: "pass",
  } as const;
  // Firma dos veces con la MISMA instancia (2ª = cache hit) y una vez con instancia
  // fresca (re-extrae). RSA-SHA1 sobre contenido fijo es determinista → las tres
  // salidas deben ser IDÉNTICAS byte-a-byte. Si la memoización alterara algo, rompe.
  const s1 = signSiiXml({ ...opts, xml, pfxBytes: src });
  const s2 = signSiiXml({ ...opts, xml, pfxBytes: src });
  const s3 = signSiiXml({ ...opts, xml, pfxBytes: fresh });
  assertEquals(s1, s2, "memoizada = memoizada");
  assertEquals(s1, s3, "memoizada = extracción fresca (byte-idéntico)");
});
