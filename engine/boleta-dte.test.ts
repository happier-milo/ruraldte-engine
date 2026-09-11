// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import forge from "npm:node-forge@1.3.1";
import {
  type BoletaDteInput,
  buildBoletaDocumento,
  buildSignedBoletaDte,
  montoItemBoleta,
} from "./boleta-dte.ts";
import { sha1Base64, verifyForgeSignature } from "./xml-signature.ts";

// CAF de prueba con par RSA generado (buildTed necesita la RSASK para la FRMT).
function genCafXml(): string {
  const kp = forge.pki.rsa.generateKeyPair({ bits: 512 });
  const privPem = forge.pki.privateKeyToPem(kp.privateKey);
  const pubPem = forge.pki.publicKeyToPem(kp.publicKey);
  return (
    `<?xml version="1.0"?><AUTORIZACION><CAF version="1.0"><DA>` +
    `<RE>78416626-0</RE><RS>COMUNIDAD RURAL SPA</RS><TD>39</TD>` +
    `<RNG><D>1</D><H>5</H></RNG><FA>2026-06-08</FA>` +
    `<RSAPK><M>abc==</M><E>Aw==</E></RSAPK><IDK>100</IDK></DA>` +
    `<FRMA algoritmo="SHA1withRSA">deadbeef==</FRMA></CAF>` +
    `<RSASK>${privPem}</RSASK><RSAPUBK>${pubPem}</RSAPUBK></AUTORIZACION>`
  );
}

// La representación impresa importa `montoItemBoleta` en vez de replicar la cuenta: esto amarra que
// sea el <MontoItem> que escribe el <Detalle> de la boleta (y fija los valores).
Deno.test("montoItemBoleta = el <MontoItem> que escribe el <Detalle> de la boleta", () => {
  const input = caso1Input();
  input.items = [
    { nombre: "A", cantidad: 3, precio: 1190 },
    { nombre: "B", cantidad: 1.5, precio: 999 },
    { nombre: "C", cantidad: 0.333, precio: 1000.4, exento: true },
  ];
  const { documento } = buildBoletaDocumento(input);
  const xml = [...documento.matchAll(/<MontoItem>([^<]+)<\/MontoItem>/g)].map((m) => Number(m[1]));
  assertEquals(xml, input.items.map((it) => montoItemBoleta(it)));
  assertEquals(xml, [3570, 1499, 333]);
});

// Inputs del CASO-1 REAL capturado del oráculo de calibración (refDteXml): 2 ítems, total 29800.
function caso1Input(): BoletaDteInput {
  return {
    tipoDte: 39,
    folio: 1,
    fechaEmision: "2026-06-08",
    indServicio: 3, // set cert = Boleta de Venta y Servicios
    emisor: {
      rut: "78416626-0",
      razonSocial: "COMUNIDAD RURAL SPA",
      giro: "PLATAFORMA SAAS Y SERVICIOS DE TECNOLOGÍA INFORMÁTICA",
      dirOrigen: "Martínez de Rozas 3550, Piso 18, Depto 1808",
      cmnaOrigen: "Quinta Normal",
    },
    receptor: { rut: "66666666-6", razonSocial: "Set de pruebas SII" },
    items: [
      { nombre: "Cambio de aceite", cantidad: 1, precio: 19900 },
      { nombre: "Alineacion y balanceo", cantidad: 1, precio: 9900 },
    ],
    totals: { neto: 25042, iva: 4758, exento: 0, total: 29800 },
    referencia: { tipoDocRef: "SET", folioRef: 1, codRef: "SET", razonRef: "CASO-1" },
    cafXml: genCafXml(),
    tstedIso: "2026-06-08T18:24:11",
    tmstFirma: "2026-06-08T18:24:11",
    documentId: "T_639165398514225199",
  };
}

Deno.test("buildBoletaDocumento: normaliza el RUTRecep (sin puntos, DV mayúscula) en XML Y TED", () => {
  // RUT con puntos y DV minúscula → debe salir canónico en el <RUTRecep> del XML y en el
  // <RR> del TED, IDÉNTICOS (si difirieran, "Firma TED no coincide" en el SII).
  const input = { ...caso1Input(), receptor: { rut: "76.543.210-k", razonSocial: "ACME SpA" } };
  const { documento } = buildBoletaDocumento(input);
  assertStringIncludes(documento, "<RUTRecep>76543210-K</RUTRecep>"); // XML
  assertStringIncludes(documento, "<RR>76543210-K</RR>"); // TED (DD)
  assert(!documento.includes("76.192.083")); // sin puntos en ningún lado
  assert(!documento.includes("76543210-k")); // DV en mayúscula
});

Deno.test("buildBoletaDocumento: consumidor final 66666666-6 se mantiene intacto", () => {
  const { documento } = buildBoletaDocumento(caso1Input());
  assertStringIncludes(documento, "<RUTRecep>66666666-6</RUTRecep>");
  assertStringIncludes(documento, "<RR>66666666-6</RR>");
});

Deno.test("buildBoletaDocumento: estructura calibrada contra el DTE real del oráculo de calibración (CASO-1)", () => {
  const { documento, documentId } = buildBoletaDocumento(caso1Input());

  // Wrapper + ID.
  assert(documento.startsWith('<Documento ID="T_639165398514225199">'));
  assert(documento.endsWith("</Documento>"));
  assertEquals(documentId, "T_639165398514225199");

  // IdDoc / Receptor / Totales — byte-exacto vs la referencia (orden de elementos).
  assertStringIncludes(
    documento,
    "<IdDoc><TipoDTE>39</TipoDTE><Folio>1</Folio><FchEmis>2026-06-08</FchEmis><IndServicio>3</IndServicio></IdDoc>",
  );
  assertStringIncludes(
    documento,
    "<Receptor><RUTRecep>66666666-6</RUTRecep><RznSocRecep>Set de pruebas SII</RznSocRecep></Receptor>",
  );
  assertStringIncludes(
    documento,
    "<Totales><MntNeto>25042</MntNeto><IVA>4758</IVA><MntTotal>29800</MntTotal></Totales>",
  );

  // Emisor: orden de elementos + valores (acentos en Unicode correcto; la
  // byte-exactitud iso-8859-1 se valida en el paso de encoding/firma).
  assertStringIncludes(
    documento,
    "<Emisor><RUTEmisor>78416626-0</RUTEmisor><RznSocEmisor>COMUNIDAD RURAL SPA</RznSocEmisor>" +
      "<GiroEmisor>PLATAFORMA SAAS Y SERVICIOS DE TECNOLOGÍA INFORMÁTICA</GiroEmisor>" +
      "<DirOrigen>Martínez de Rozas 3550, Piso 18, Depto 1808</DirOrigen>" +
      "<CmnaOrigen>Quinta Normal</CmnaOrigen></Emisor>",
  );

  // Detalle: ambas líneas byte-exacto vs la referencia.
  assertStringIncludes(
    documento,
    "<Detalle><NroLinDet>1</NroLinDet><NmbItem>Cambio de aceite</NmbItem><QtyItem>1</QtyItem>" +
      "<UnmdItem>un</UnmdItem><PrcItem>19900</PrcItem><MontoItem>19900</MontoItem></Detalle>",
  );
  assertStringIncludes(
    documento,
    "<Detalle><NroLinDet>2</NroLinDet><NmbItem>Alineacion y balanceo</NmbItem><QtyItem>1</QtyItem>" +
      "<UnmdItem>un</UnmdItem><PrcItem>9900</PrcItem><MontoItem>9900</MontoItem></Detalle>",
  );

  // Referencia del SET — cinturón y tirantes: TpoDocRef="SET"+FolioRef (convención
  // factura, Formato v4.2 §E lo admite alfabético) Y CodRef="SET" (instrucción
  // literal del Set Prueba BE.txt; en boleta CodRef es código libre, no enum).
  assertStringIncludes(
    documento,
    "<Referencia><NroLinRef>1</NroLinRef><TpoDocRef>SET</TpoDocRef><FolioRef>1</FolioRef><CodRef>SET</CodRef><RazonRef>CASO-1</RazonRef></Referencia>",
  );

  // TED embebido con el DD COMPACTO (mismo timbre validado byte-a-byte) + FRMT.
  assertStringIncludes(
    documento,
    '<TED version="1.0"><DD><RE>78416626-0</RE><TD>39</TD><F>1</F><FE>2026-06-08</FE>' +
      "<RR>66666666-6</RR><RSR>Set de pruebas SII</RSR><MNT>29800</MNT><IT1>Cambio de aceite</IT1>",
  );
  assertStringIncludes(documento, '<FRMA algoritmo="SHA1withRSA">');
  assertStringIncludes(documento, '<FRMT algoritmo="SHA1withRSA">');

  // TmstFirma al cierre del Documento.
  assertStringIncludes(documento, "<TmstFirma>2026-06-08T18:24:11</TmstFirma></Documento>");

  // Invariante compacto: el Documento NO lleva whitespace entre tags.
  assert(!/>\s+</.test(documento), "el Documento debe ser compacto (sin whitespace entre tags)");
});

Deno.test("buildBoletaDocumento: boleta exenta (41) lleva IndExe + MntExento, sin MntNeto/IVA", () => {
  const input = caso1Input();
  input.tipoDte = 41;
  input.items = [{ nombre: "Consumo de agua", cantidad: 1, precio: 5000, exento: true }];
  input.totals = { neto: 0, iva: 0, exento: 5000, total: 5000 };
  const { documento } = buildBoletaDocumento(input);
  assertStringIncludes(
    documento,
    "<Totales><MntExe>5000</MntExe><MntTotal>5000</MntTotal></Totales>",
  );
  assertStringIncludes(documento, "<IndExe>1</IndExe>");
  assert(!documento.includes("<MntNeto>"), "exenta no lleva MntNeto");
  assert(!documento.includes("<IVA>"), "exenta no lleva IVA");
});

// ── Firma XMLDSig: digest del Documento ──────────────────────────────────────
// <Documento> REAL del oráculo de calibración (CASO-1) reconstruido en iso-8859-1 (Latin-1) +
// su DigestValue REAL. Prueba viva de cómo el SII computa el digest: C14N
// inclusivo (CRLF→LF + expandir elementos vacíos + UTF-8). Reproducirlo valida —
// sin Maullin — que nuestra firma del DTE va sobre la forma correcta.
const REF_DOC_DIGEST = "XOCYP/zCz2LGKChHAqrT+KE5Zvk=";
const REF_DOC_LATIN1_B64 = `
PERvY3VtZW50byBJRD0iVF82MzkxNjUzOTg1MTQyMjUxOTkiPg0KPEVuY2FiZXphZG8+DQo8SWRE
b2M+DQo8VGlwb0RURT4zOTwvVGlwb0RURT4NCjxGb2xpbz4xPC9Gb2xpbz4NCjxGY2hFbWlzPjIw
MjYtMDYtMDg8L0ZjaEVtaXM+DQo8L0lkRG9jPg0KPEVtaXNvcj4NCjxSVVRFbWlzb3I+Nzg0MTY2
MjYtMDwvUlVURW1pc29yPg0KPFJ6blNvY0VtaXNvcj5DT01VTklEQUQgUlVSQUwgU1BBPC9Sem5T
b2NFbWlzb3I+DQo8R2lyb0VtaXNvcj5QTEFUQUZPUk1BIFNBQVMgWSBTRVJWSUNJT1MgREUgVEVD
Tk9MT0fNQSBJTkZPUk3BVElDQTwvR2lyb0VtaXNvcj4NCjxEaXJPcmlnZW4+TWFydO1uZXogZGUg
Um96YXMgMzU1MCwgUGlzbyAxOCwgRGVwdG8gMTgwODwvRGlyT3JpZ2VuPg0KPENtbmFPcmlnZW4+
UXVpbnRhIE5vcm1hbDwvQ21uYU9yaWdlbj4NCjwvRW1pc29yPg0KPFJlY2VwdG9yPg0KPFJVVFJl
Y2VwPjY2NjY2NjY2LTY8L1JVVFJlY2VwPg0KPFJ6blNvY1JlY2VwPlNldCBkZSBwcnVlYmFzIFNJ
STwvUnpuU29jUmVjZXA+DQo8L1JlY2VwdG9yPg0KPFRvdGFsZXM+DQo8TW50TmV0bz4yNTA0Mjwv
TW50TmV0bz4NCjxJVkE+NDc1ODwvSVZBPg0KPE1udFRvdGFsPjI5ODAwPC9NbnRUb3RhbD4NCjwv
VG90YWxlcz4NCjwvRW5jYWJlemFkbz4NCjxEZXRhbGxlPg0KPE5yb0xpbkRldD4xPC9Ocm9MaW5E
ZXQ+DQo8Tm1iSXRlbT5DYW1iaW8gZGUgYWNlaXRlPC9ObWJJdGVtPg0KPFF0eUl0ZW0+MTwvUXR5
SXRlbT4NCjxVbm1kSXRlbT51bjwvVW5tZEl0ZW0+DQo8UHJjSXRlbT4xOTkwMDwvUHJjSXRlbT4N
CjxNb250b0l0ZW0+MTk5MDA8L01vbnRvSXRlbT4NCjwvRGV0YWxsZT4NCjxEZXRhbGxlPg0KPE5y
b0xpbkRldD4yPC9Ocm9MaW5EZXQ+DQo8Tm1iSXRlbT5BbGluZWFjaW9uIHkgYmFsYW5jZW88L05t
Ykl0ZW0+DQo8UXR5SXRlbT4xPC9RdHlJdGVtPg0KPFVubWRJdGVtPnVuPC9Vbm1kSXRlbT4NCjxQ
cmNJdGVtPjk5MDA8L1ByY0l0ZW0+DQo8TW9udG9JdGVtPjk5MDA8L01vbnRvSXRlbT4NCjwvRGV0
YWxsZT4NCjxSZWZlcmVuY2lhPg0KPE5yb0xpblJlZj4xPC9Ocm9MaW5SZWY+DQo8VHBvRG9jUmVm
IC8+DQo8Rm9saW9SZWY+MTwvRm9saW9SZWY+DQo8UmF6b25SZWY+Q0FTTy0xPC9SYXpvblJlZj4N
CjwvUmVmZXJlbmNpYT4NCjxURUQgdmVyc2lvbj0iMS4wIj4NCjxERD4NCjxSRT43ODQxNjYyNi0w
PC9SRT4NCjxURD4zOTwvVEQ+DQo8Rj4xPC9GPg0KPEZFPjIwMjYtMDYtMDg8L0ZFPg0KPFJSPjY2
NjY2NjY2LTY8L1JSPg0KPFJTUj5TZXQgZGUgcHJ1ZWJhcyBTSUk8L1JTUj4NCjxNTlQ+Mjk4MDA8
L01OVD4NCjxJVDE+Q2FtYmlvIGRlIGFjZWl0ZTwvSVQxPg0KPENBRiB2ZXJzaW9uPSIxLjAiPg0K
PERBPg0KPFJFPjc4NDE2NjI2LTA8L1JFPg0KPFJTPkNPTVVOSURBRCBSVVJBTCBTUEE8L1JTPg0K
PFREPjM5PC9URD4NCjxSTkc+DQo8RD4xPC9EPg0KPEg+NTwvSD4NCjwvUk5HPg0KPEZBPjIwMjYt
MDYtMDg8L0ZBPg0KPFJTQVBLPg0KPE0+c2xYcWFlTXB5bWxILzdEREJlOXRyblI1UDFneHNlUEJ0
dHAvTXUvVG5XOXA0cmdCMjVUeHIvV09nc0pWZWl1Z2tGYWZXUUVJTk91Z3pkdE0yK3diMlE9PTwv
TT4NCjxFPkF3PT08L0U+DQo8L1JTQVBLPg0KPElESz4xMDA8L0lESz4NCjwvREE+DQo8RlJNQSBh
bGdvcml0bW89IlNIQTF3aXRoUlNBIj5PeFYrMVplOWJqVm1CTk1FMVYwV3c5UEFQbXNZTlkxUzUv
UUppOXZmOW11SnVyTlhhd0l6bU5xQU1EWnVXalZkSll3aXVlZkhZRk9iMERuZVpFRUdsQT09PC9G
Uk1BPg0KPC9DQUY+DQo8VFNURUQ+MjAyNi0wNi0wOFQxODoyNDoxMTwvVFNURUQ+DQo8L0REPg0K
PEZSTVQgYWxnb3JpdG1vPSJTSEExd2l0aFJTQSI+SnBIdmhoU1JKTG9iNjZmZEVhenJ6SjNsOEZm
OCtWcVpYMWdCWHlpNURhWGxGMXBUKzBIam1nQjZlRStPbTZLeUtqclhJcHE0SDUzaW1ub3NDcmpy
eFE9PTwvRlJNVD4NCjwvVEVEPg0KPFRtc3RGaXJtYT4yMDI2LTA2LTA4VDE4OjI0OjExPC9UbXN0
RmlybWE+DQo8L0RvY3VtZW50bz4=`.replace(/\s/g, "");

Deno.test("C14N: reproducimos el DigestValue REAL del oráculo de calibración (digest del Documento, sin Maullin)", () => {
  const s = forge.util.decode64(REF_DOC_LATIN1_B64);
  // C14N inclusivo: CRLF→LF + expandir elementos vacíos (<X/>→<X></X>) + UTF-8.
  const c14n = s
    .replace(/\r\n/g, "\n")
    .replace(/<([\w:]+)((?:\s+[\w:]+="[^"]*")*)\s*\/>/g, "<$1$2></$1>");
  const md = forge.md.sha1.create();
  md.update(c14n, "utf8");
  assertEquals(forge.util.encode64(md.digest().getBytes()), REF_DOC_DIGEST);
});

// .pfx de prueba (cert + key generados) para firmar el DTE.
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

Deno.test("buildSignedBoletaDte: DTE firmado — forma oráculo (Documento pretty, Signature compacta) + firma válida", () => {
  const { pfxBytes, publicKey } = makeTestPfx();
  const input = caso1Input();
  const { documento } = buildBoletaDocumento(input);
  const dte = buildSignedBoletaDte(input, pfxBytes, "pass");

  // Envoltorio iso-8859-1 + DTE sin xmlns; Documento PRETTY en línea propia
  // (forma del oráculo de calibración, SII-aceptada; observado vivo 2026-06-10).
  assert(
    dte.startsWith('<?xml version="1.0" encoding="iso-8859-1"?><DTE version="1.0">\r\n<Documento '),
  );
  assert(dte.endsWith("</Signature></DTE>"));
  assertStringIncludes(dte, "</Documento>\r\n<Signature ");
  // Documento pretty: cada frontera de tags con CRLF.
  assertStringIncludes(dte, "<Encabezado>\r\n<IdDoc>\r\n<TipoDTE>39</TipoDTE>");

  // DigestValue = SHA1(utf8(C14N(Documento pretty))) = pretty con CRLF→LF.
  const digest = dte.match(/<DigestValue>([^<]+)<\/DigestValue>/)?.[1];
  assertEquals(digest, sha1Base64(documento.replace(/></g, ">\n<")));

  // Reference al Documento por ID + transform C14N (espeja al oráculo de calibración).
  assertStringIncludes(dte, '<Reference URI="#T_639165398514225199">');
  assertStringIncludes(
    dte,
    '<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>',
  );

  // Signature COMPACTA (whitespace entre sus hijos → LPX-00007 del SII) con el
  // base64 del X509 envuelto a 76 (tope de 4096 chars/línea).
  assertStringIncludes(dte, "</SignedInfo><SignatureValue>");
  const x509 = dte.match(/<X509Certificate>([\s\S]+?)<\/X509Certificate>/)?.[1] ?? "";
  assertStringIncludes(x509, "\r\n");
  const maxLine = Math.max(...dte.split(/\r\n/).map((l) => l.length));
  assert(maxLine < 4000, `línea máxima ${maxLine} debe quedar bajo el tope SII`);

  // La firma RSA-SHA1 del SignedInfo verifica (roundtrip).
  assert(verifyForgeSignature(dte, publicKey), "la firma del DTE debe verificar");
});
