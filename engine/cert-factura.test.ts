// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// cert-factura.test.ts — valida el harness del set de factura: cómputo de totales
// (descuentos línea/global, mixto) + mapeo de casos a DTEs (folios por tipo,
// referencia SET, resolución de referencias NC→doc corregido).
// ============================================================================

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import forge from "npm:node-forge@1.3.1";
import {
  buildCertFacturaDtes,
  buildCertFacturaMuestras,
  buildCertLibros,
  buildCertLibroComprasDetalles,
  type BuildCertFacturaArgs,
  computeFacturaCertTotals,
  computeLiquidacionCertTotals,
  DEFAULT_FACTURA_CERT_CASES,
  DEFAULT_FACTURA_CERT_RECEPTOR,
  type FacturaCertCase,
} from "./cert-factura.ts";

function genCafXml(td: number): string {
  const kp = forge.pki.rsa.generateKeyPair({ bits: 512 });
  return `<?xml version="1.0"?><AUTORIZACION><CAF version="1.0"><DA>` +
    `<RE>78416626-0</RE><RS>COMUNIDAD RURAL SPA</RS><TD>${td}</TD>` +
    `<RNG><D>1</D><H>200</H></RNG><FA>2026-06-12</FA>` +
    `<RSAPK><M>abc==</M><E>Aw==</E></RSAPK><IDK>100</IDK></DA>` +
    `<FRMA algoritmo="SHA1withRSA">deadbeef==</FRMA></CAF>` +
    `<RSASK>${forge.pki.privateKeyToPem(kp.privateKey)}</RSASK></AUTORIZACION>`;
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
  const out = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) out[i] = der.charCodeAt(i);
  return out;
}

Deno.test("computeFacturaCertTotals: descuento línea (CASO básico-2)", () => {
  // Pañuelo 777×6014 -10% + ITEM2 722×5064 -23%
  const t = computeFacturaCertTotals([
    { nombre: "Pañuelo", cantidad: 777, precio: 6014, descuentoPct: 10 },
    { nombre: "ITEM2", cantidad: 722, precio: 5064, descuentoPct: 23 },
  ]);
  // línea1: 4672878 − 467288 = 4205590; línea2: 3656208 − 840928 = 2815280 → neto 7020870
  assertEquals(t.neto, 4205590 + 2815280);
  assertEquals(t.iva, Math.round(t.neto * 0.19));
  assertEquals(t.total, t.neto + t.iva);
});

Deno.test("computeFacturaCertTotals: mixto afecto+exento (CASO básico-3)", () => {
  const t = computeFacturaCertTotals([
    { nombre: "Pintura", cantidad: 66, precio: 7023 },
    { nombre: "ITEM2", cantidad: 239, precio: 4067 },
    { nombre: "Servicio exento", cantidad: 1, precio: 35313, exento: true },
  ]);
  const neto = 66 * 7023 + 239 * 4067;
  assertEquals(t.neto, neto);
  assertEquals(t.exento, 35313);
  assertEquals(t.iva, Math.round(neto * 0.19));
  assertEquals(t.total, neto + Math.round(neto * 0.19) + 35313);
});

Deno.test("computeFacturaCertTotals: descuento global afecto (CASO básico-4)", () => {
  const t = computeFacturaCertTotals(
    [
      { nombre: "I1", cantidad: 426, precio: 6069 },
      { nombre: "I2", cantidad: 180, precio: 7409 },
      { nombre: "Exento", cantidad: 2, precio: 6835, exento: true },
    ],
    23,
  );
  const afecto = 426 * 6069 + 180 * 7409;
  const neto = afecto - Math.round(afecto * 0.23);
  assertEquals(t.neto, neto);
  assertEquals(t.exento, 2 * 6835);
  assertEquals(t.iva, Math.round(neto * 0.19));
});

Deno.test("buildCertFacturaDtes: folios por tipo + referencia SET + referencias NC→factura, ND→NC", () => {
  const pfx = makeTestPfx();
  const cases: FacturaCertCase[] = [
    { caso: "4897293-1", nroCaso: 1, tipoDocumento: 33, items: [{ nombre: "Cajón", cantidad: 170, precio: 3581 }] },
    { caso: "4897293-2", nroCaso: 2, tipoDocumento: 33, items: [{ nombre: "Pañuelo", cantidad: 777, precio: 6014, descuentoPct: 10 }] },
    { caso: "4897293-5", nroCaso: 5, tipoDocumento: 61, ref: { caso: "4897293-1", codRef: 2, razon: "CORRIGE GIRO DEL RECEPTOR" } },
    { caso: "4897293-8", nroCaso: 8, tipoDocumento: 56, ref: { caso: "4897293-5", codRef: 1, razon: "ANULA NOTA DE CREDITO ELECTRONICA" } },
  ];
  const args: BuildCertFacturaArgs = {
    cases,
    emisor: {
      rut: "78416626-0",
      legalName: "COMUNIDAD RURAL SPA",
      giro: "SERVICIOS",
      acteco: 620200,
      dirOrigen: "Martínez de Rozas 3550",
      cmnaOrigen: "Quinta Normal",
      ciudadOrigen: "Santiago",
    },
    receptor: { rut: "77777777-7", razonSocial: "EMPRESA LTDA", giro: "Comercio", dirRecep: "San Diego 2222", cmnaRecep: "Santiago" },
    firstFolioByType: { 33: 100, 61: 200, 56: 300 },
    cafByType: { 33: genCafXml(33), 61: genCafXml(61), 56: genCafXml(56) },
    fechaEmision: "2026-06-14",
    tstedIso: "2026-06-14T10:00:00",
  };

  const dtes = buildCertFacturaDtes(args, pfx, "pass");
  assertEquals(dtes.map((d) => `${d.tipoDocumento}/${d.folio}`), ["33/100", "33/101", "61/200", "56/300"]);

  // El DTE per-documento se emite pretty (CRLF entre tags) → aplanar para asertar.
  const flat = (s: string) => s.replace(/\r\n/g, "");

  // Caso 1: referencia SET (TpoDocRef SET, FolioRef=nroCaso, RazonRef="CASO 4897293-1")
  const c1 = flat(dtes[0].signedDte);
  assertStringIncludes(c1, "<TpoDocRef>SET</TpoDocRef><FolioRef>1</FolioRef>");
  assertStringIncludes(c1, "<RazonRef>CASO 4897293-1</RazonRef>");

  // NC caso 5: ref SET + ref a la factura del caso 1 (T33 folio 100, CodRef 2)
  const c5 = flat(dtes[2].signedDte);
  assertStringIncludes(c5, "<TpoDocRef>SET</TpoDocRef><FolioRef>5</FolioRef>");
  assertStringIncludes(c5, "<TpoDocRef>33</TpoDocRef><FolioRef>100</FolioRef><FchRef>2026-06-14</FchRef><CodRef>2</CodRef>");
  assertStringIncludes(c5, "<TipoDTE>61</TipoDTE><Folio>200</Folio>");

  // ND caso 8: ref a la NC del caso 5 (T61 folio 200, CodRef 1=anula)
  const c8 = flat(dtes[3].signedDte);
  assertStringIncludes(c8, "<TpoDocRef>61</TpoDocRef><FolioRef>200</FolioRef><FchRef>2026-06-14</FchRef><CodRef>1</CodRef>");
  assert(dtes[2].totals.total === 0, "NC corrige-texto sin ítems → total 0");
});

// ── Multi-CAF: folios de un tipo repartidos en VARIOS CAF (timbraje en tandas) ──
// El SII no siempre entrega todos los folios del set en un solo CAF (un emisor nuevo
// topa el máximo a timbrar). El resolver debe firmar cada folio con el CAF cuyo rango
// lo contiene. Caso real: T61 con CAF 1-10 (sin usar 8,9,10) + CAF 11-14 → un set de
// 4 NC abarca ambos: folios 8,9,10 firman con el CAF viejo y 11 con el nuevo.
function genCafXmlRanged(td: number, from: number, to: number, idk: number): string {
  const kp = forge.pki.rsa.generateKeyPair({ bits: 512 });
  return `<?xml version="1.0"?><AUTORIZACION><CAF version="1.0"><DA>` +
    `<RE>78416626-0</RE><RS>COMUNIDAD RURAL SPA</RS><TD>${td}</TD>` +
    `<RNG><D>${from}</D><H>${to}</H></RNG><FA>2026-06-12</FA>` +
    `<RSAPK><M>abc==</M><E>Aw==</E></RSAPK><IDK>${idk}</IDK></DA>` +
    `<FRMA algoritmo="SHA1withRSA">deadbeef==</FRMA></CAF>` +
    `<RSASK>${forge.pki.privateKeyToPem(kp.privateKey)}</RSASK></AUTORIZACION>`;
}

Deno.test("buildCertFacturaDtes: un tipo abarca DOS CAF (cada folio firma con el CAF de su rango)", () => {
  const pfx = makeTestPfx();
  // Factura base + 4 NC: folios 61 = 8,9,10 (CAF viejo 1-10) + 11 (CAF nuevo 11-14).
  const cases: FacturaCertCase[] = [
    { caso: "f1", nroCaso: 1, tipoDocumento: 33, items: [{ nombre: "X", cantidad: 1, precio: 1000 }] },
    { caso: "n1", nroCaso: 2, tipoDocumento: 61, ref: { caso: "f1", codRef: 2, razon: "R1" } },
    { caso: "n2", nroCaso: 3, tipoDocumento: 61, ref: { caso: "f1", codRef: 2, razon: "R2" } },
    { caso: "n3", nroCaso: 4, tipoDocumento: 61, ref: { caso: "f1", codRef: 2, razon: "R3" } },
    { caso: "n4", nroCaso: 5, tipoDocumento: 61, ref: { caso: "f1", codRef: 2, razon: "R4" } },
  ];
  const args: BuildCertFacturaArgs = {
    cases,
    emisor: EMISOR_FIXT,
    receptor: { rut: "77777777-7", razonSocial: "EMPRESA LTDA", giro: "Comercio", dirRecep: "San Diego 2222", cmnaRecep: "Santiago" },
    firstFolioByType: { 33: 100, 61: 8 },
    cafByType: { 33: genCafXml(33) }, // 61 va por segmentos, abajo
    cafSegmentsByType: {
      61: [
        { cafXml: genCafXmlRanged(61, 1, 10, 111), firstFolio: 1, lastFolio: 10 },
        { cafXml: genCafXmlRanged(61, 11, 14, 222), firstFolio: 11, lastFolio: 14 },
      ],
    },
    fechaEmision: "2026-06-14",
    tstedIso: "2026-06-14T10:00:00",
  };

  const dtes = buildCertFacturaDtes(args, pfx, "pass");
  assertEquals(dtes.map((d) => `${d.tipoDocumento}/${d.folio}`), ["33/100", "61/8", "61/9", "61/10", "61/11"]);

  const flat = (s: string) => s.replace(/\r\n/g, "");
  // El TED embebe el <CAF> usado → su IDK distingue qué CAF firmó cada folio.
  for (const i of [1, 2, 3]) { // folios 8,9,10 → CAF viejo (IDK 111)
    assertStringIncludes(flat(dtes[i].signedDte), "<IDK>111</IDK>");
  }
  // folio 11 → CAF nuevo (IDK 222), NO el viejo
  assertStringIncludes(flat(dtes[4].signedDte), "<IDK>222</IDK>");
  assert(!flat(dtes[4].signedDte).includes("<IDK>111</IDK>"), "folio 11 NO debe firmar con el CAF viejo");
});

Deno.test("buildCertFacturaDtes: folio fuera de todos los CAF del tipo → error claro", () => {
  const pfx = makeTestPfx();
  const cases: FacturaCertCase[] = [
    { caso: "f1", nroCaso: 1, tipoDocumento: 33, items: [{ nombre: "X", cantidad: 1, precio: 1000 }] },
    { caso: "n1", nroCaso: 2, tipoDocumento: 61, ref: { caso: "f1", codRef: 2, razon: "R1" } },
    { caso: "n2", nroCaso: 3, tipoDocumento: 61, ref: { caso: "f1", codRef: 2, razon: "R2" } },
  ];
  const args: BuildCertFacturaArgs = {
    cases,
    emisor: EMISOR_FIXT,
    receptor: { rut: "77777777-7", razonSocial: "EMPRESA LTDA", giro: "Comercio", dirRecep: "San Diego 2222", cmnaRecep: "Santiago" },
    firstFolioByType: { 33: 100, 61: 10 }, // arranca en 10: segundo folio (11) NO está cubierto
    cafByType: { 33: genCafXml(33) },
    cafSegmentsByType: { 61: [{ cafXml: genCafXmlRanged(61, 1, 10, 111), firstFolio: 1, lastFolio: 10 }] },
    fechaEmision: "2026-06-14",
    tstedIso: "2026-06-14T10:00:00",
  };
  let threw = "";
  try {
    buildCertFacturaDtes(args, pfx, "pass");
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  assertStringIncludes(threw, "folio 11");
});

// ── Set por defecto completo (los 25 casos del set nuevo 4907369/73/75/76/77) ──

const EMISOR_FIXT = {
  rut: "78416626-0",
  legalName: "COMUNIDAD RURAL SPA",
  giro: "SERVICIOS",
  acteco: 620200,
  dirOrigen: "Martínez de Rozas 3550",
  cmnaOrigen: "Quinta Normal",
  ciudadOrigen: "Santiago",
};

function defaultSetArgs(): BuildCertFacturaArgs {
  // Incluye 110/111/112 (exportación). 46 se mantiene para que genere CAF aunque el
  // set nuevo ya no traiga casos FC 46 (escalado a mesa de ayuda — catch-22 del SII).
  const tipos = [33, 34, 43, 46, 52, 56, 61, 110, 111, 112];
  const cafByType: Record<number, string> = {};
  const firstFolioByType: Record<number, number> = {};
  for (const t of tipos) {
    cafByType[t] = genCafXml(t);
    firstFolioByType[t] = 1;
  }
  return {
    cases: DEFAULT_FACTURA_CERT_CASES,
    emisor: EMISOR_FIXT,
    receptor: {
      rut: DEFAULT_FACTURA_CERT_RECEPTOR.rut,
      razonSocial: DEFAULT_FACTURA_CERT_RECEPTOR.razonSocial,
      giro: DEFAULT_FACTURA_CERT_RECEPTOR.giro,
      dirRecep: DEFAULT_FACTURA_CERT_RECEPTOR.dirRecep,
      cmnaRecep: DEFAULT_FACTURA_CERT_RECEPTOR.cmnaRecep,
    },
    firstFolioByType,
    cafByType,
    fechaEmision: "2026-06-14",
    tstedIso: "2026-06-14T10:00:00",
  };
}

Deno.test("DEFAULT_FACTURA_CERT_CASES: 25 casos, todos firman sin throw", () => {
  assertEquals(DEFAULT_FACTURA_CERT_CASES.length, 25);
  const dtes = buildCertFacturaDtes(defaultSetArgs(), makeTestPfx(), "pass");
  assertEquals(dtes.length, 25);
  for (const d of dtes) {
    assertStringIncludes(d.signedDte, "<Signature");
    assertStringIncludes(d.signedDte, `<TipoDTE>${d.tipoDocumento}</TipoDTE>`);
  }
});

Deno.test("DEFAULT cases: folios secuenciales por tipo (33,34,52,56,61,110,111,112 desde 1)", () => {
  const dtes = buildCertFacturaDtes(defaultSetArgs(), makeTestPfx(), "pass");
  const folioByCaso = new Map(dtes.map((d) => [d.caso, `${d.tipoDocumento}/${d.folio}`]));
  // 4 facturas 33 del básico → folios 1..4
  assertEquals(folioByCaso.get("4907369-1"), "33/1");
  assertEquals(folioByCaso.get("4907369-4"), "33/4");
  // NC 61: básico (3: casos 5,6,7) desde folio 1; exenta (3: casos 2,4,7) → 61/4,5,6.
  assertEquals(folioByCaso.get("4907369-5"), "61/1");
  assertEquals(folioByCaso.get("4907375-2"), "61/4");
  assertEquals(folioByCaso.get("4907375-7"), "61/6");
  // ND 56: básico (1: caso 8) → 56/1; exenta (2: casos 5,8) → 56/2,3.
  assertEquals(folioByCaso.get("4907369-8"), "56/1");
  assertEquals(folioByCaso.get("4907375-8"), "56/3");
  // Exentas 34 → folios 1..3 (casos 1,3,6)
  assertEquals(folioByCaso.get("4907375-1"), "34/1");
  assertEquals(folioByCaso.get("4907375-6"), "34/3");
  // Guías 52 → 1..3
  assertEquals(folioByCaso.get("4907373-1"), "52/1");
  assertEquals(folioByCaso.get("4907373-3"), "52/3");
  // Exportación: 110 → export1-1 + export2 (1,2,3) = 110/1..4; 112 (NC export) → 112/1; 111 (ND export) → 111/1.
  assertEquals(folioByCaso.get("4907376-1"), "110/1");
  assertEquals(folioByCaso.get("4907377-1"), "110/2");
  assertEquals(folioByCaso.get("4907377-3"), "110/4");
  assertEquals(folioByCaso.get("4907376-2"), "112/1");
  assertEquals(folioByCaso.get("4907376-3"), "111/1");
});

Deno.test("DEFAULT: NC anula (caso 7) replica el total de la factura anulada (caso 3)", () => {
  const dtes = buildCertFacturaDtes(defaultSetArgs(), makeTestPfx(), "pass");
  const c3 = dtes.find((d) => d.caso === "4907369-3")!;
  const c7 = dtes.find((d) => d.caso === "4907369-7")!;
  assertEquals(c7.totals.total, c3.totals.total);
  assert(c7.totals.total > 0);
});

Deno.test("DEFAULT: guía traslado interno (caso 4907373-1) → receptor = emisor", () => {
  const dtes = buildCertFacturaDtes(defaultSetArgs(), makeTestPfx(), "pass");
  const g1 = dtes.find((d) => d.caso === "4907373-1")!;
  const flat = g1.signedDte.replace(/\r\n/g, "");
  assertStringIncludes(flat, `<RUTRecep>${EMISOR_FIXT.rut}</RUTRecep>`);
  // Traslado interno: solo IndTraslado=5, SIN TipoDespacho (reparo "indicadores no corresponden").
  assertStringIncludes(flat, "<IndTraslado>5</IndTraslado>");
  assert(!flat.includes("<TipoDespacho>"), "traslado interno NO debe llevar TipoDespacho");
});

Deno.test("liquidación-factura (43) reproduce el ejemplo CERTIFICADO del SII", () => {
  // archivofacturaliquidacion.php — Detalle línea 1 (afecta): CdgItem INT1/0, TpoDocLiq 33,
  // QtyItem 1, UnmdItem UN, MontoItem 165775. Totales: MntNeto 234955 / MntExe 55068 / IVA 44641 /
  // IVAProp 918 / IVATerc 43723 / Comisiones{ValComNeto 4834, ValComIVA 918} / MntTotal 328912.
  // MntNeto = Σ líneas AFECTAS del ejemplo = 165775 + 69180 = 234955 (la comisión 4834 NO se suma al
  // neto; va aparte en <Comisiones> y se RESTA en MntTotal). Reproducimos las líneas afectas/exenta y la
  // comisión, y comprobamos que computeLiquidacionCertTotals da EXACTO las cifras del ejemplo certificado.
  const items = [
    { nombre: "NETO FACTURA ELECTRONICA 1515", cantidad: 1, precio: 0, montoItem: 165775, tpoDocLiq: 33 },
    { nombre: "NETO FACTURAS ELECTRONICAS", cantidad: 129, precio: 0, montoItem: 69180, tpoDocLiq: 33 },
    { nombre: "EXENTO", cantidad: 22, precio: 0, montoItem: 55068, exento: true, tpoDocLiq: 33 },
  ];
  const com = [{ tipoMovim: "C" as const, glosa: "COMISION", neto: 4834 }];
  const t = computeLiquidacionCertTotals(items, com);
  assertEquals(t.neto, 234955); // MntNeto = netoDocs (Σ afectas 165775+69180) = 234955; la comisión NO se suma
  assertEquals(t.exento, 55068);
  assertEquals(t.iva, 44641); // round(234955 × 0.19)
  assertEquals(t.ivaProp, 918); // = ValComIVA = round(4834 × 0.19)
  assertEquals(t.ivaTerc, 43723); // = IVA − IVAProp = 44641 − 918
  assertEquals(t.valComNeto, 4834);
  assertEquals(t.valComIVA, 918);
  assertEquals(t.total, 328912); // 234955 + 55068 + 44641 − 4834 − 0 − 918
});

Deno.test("DEFAULT: factura exenta (34) emite MntExe sin IVA", () => {
  const dtes = buildCertFacturaDtes(defaultSetArgs(), makeTestPfx(), "pass");
  const e1 = dtes.find((d) => d.caso === "4907375-1")!;
  const flat = e1.signedDte.replace(/\r\n/g, "");
  assertStringIncludes(flat, `<MntExe>${11 * 6348}</MntExe>`);
  assert(!flat.includes("<IVA>"), "factura exenta no lleva IVA");
});

// ── Tabla dorada: valores esperados por el SII (regresión de los reparos SRH 2026-06-15) ──

// Valores esperados por caso (neto/exento/iva/retención/total). Fuente: tabla dorada
// autoritativa de scripts/precheck-cert-factura.ts (GOLDEN). Set nuevo 2026-06-18 v3.
// OJO: los montos de exportación (4907376/77) son DECIMALES (xs:decimal/4) — el regex
// que lee MntExe/MntTotal acepta `\d+(?:\.\d+)?` y se compara como número.
const GOLDEN_TOTALS: Record<string, { neto: number; exento: number; iva: number; reten: number; total: number }> = {
  // ── SET BÁSICO 4907369 (factura afecta 33 / NC 61 / ND 56) ──
  "4907369-1": { neto: 229572, exento: 0, iva: 43619, reten: 0, total: 273191 },
  "4907369-2": { neto: 778871, exento: 0, iva: 147985, reten: 0, total: 926856 },
  "4907369-3": { neto: 520856, exento: 34740, iva: 98963, reten: 0, total: 654559 },
  "4907369-4": { neto: 251413, exento: 13542, iva: 47768, reten: 0, total: 312723 },
  "4907369-5": { neto: 0, exento: 0, iva: 0, reten: 0, total: 0 },
  "4907369-6": { neto: 354899, exento: 0, iva: 67431, reten: 0, total: 422330 },
  "4907369-7": { neto: 520856, exento: 34740, iva: 98963, reten: 0, total: 654559 },
  "4907369-8": { neto: 0, exento: 0, iva: 0, reten: 0, total: 0 },
  // ── SET GUÍA 4907373 (52) ──
  "4907373-1": { neto: 0, exento: 0, iva: 0, reten: 0, total: 0 }, // traslado interno: sin valor → MntTotal=0
  "4907373-2": { neto: 3618358, exento: 0, iva: 687488, reten: 0, total: 4305846 },
  "4907373-3": { neto: 2681628, exento: 0, iva: 509509, reten: 0, total: 3191137 },
  // ── SET FACTURA EXENTA 4907375 (34 / NC 61 / ND 56): solo MntExe + MntTotal, sin IVA ──
  "4907375-1": { neto: 0, exento: 69828, iva: 0, reten: 0, total: 69828 },
  "4907375-2": { neto: 0, exento: 8734, iva: 0, reten: 0, total: 8734 },
  "4907375-3": { neto: 0, exento: 586632, iva: 0, reten: 0, total: 586632 },
  "4907375-4": { neto: 0, exento: 0, iva: 0, reten: 0, total: 0 },
  "4907375-5": { neto: 0, exento: 0, iva: 0, reten: 0, total: 0 },
  "4907375-6": { neto: 0, exento: 568913, iva: 0, reten: 0, total: 568913 },
  "4907375-7": { neto: 0, exento: 169591, iva: 0, reten: 0, total: 169591 },
  "4907375-8": { neto: 0, exento: 45946, iva: 0, reten: 0, total: 45946 },
  // ── SET EXPORTACIÓN (1) 4907376 (FRANCO SZ) — 110/112/111, todo exento (MntExe=MntTotal, sin IVA) ──
  "4907376-1": { neto: 0, exento: 112517.50, iva: 0, reten: 0, total: 112517.50 }, // 109233 (687×159) + flete 2069.28 + seguro 1215.22
  "4907376-2": { neto: 0, exento: 36411, iva: 0, reten: 0, total: 36411 }, // NC 229 × 159
  "4907376-3": { neto: 0, exento: 36411, iva: 0, reten: 0, total: 36411 }, // ND anula NC
  // ── SET EXPORTACIÓN (2) 4907377 (YEN + DOLAR USA) — 110 × 3 ──
  "4907377-1": { neto: 0, exento: 103.4, iva: 0, reten: 0, total: 103.4 }, // 94 + 10% recargo línea (YEN)
  "4907377-2": { neto: 0, exento: 233792.38, iva: 0, reten: 0, total: 233792.38 }, // 223011 + com 617.45 + flete 5251.25 + seguro 4912.68 (YEN)
  "4907377-3": { neto: 0, exento: 281, iva: 0, reten: 0, total: 281 }, // alojamiento (DOLAR USA)
};

Deno.test("DEFAULT set: los 25 DTEs cuadran con la tabla dorada del SII", () => {
  const dtes = buildCertFacturaDtes(defaultSetArgs(), makeTestPfx(), "pass");
  assertEquals(dtes.length, 25);
  for (const d of dtes) {
    const xml = d.signedDte.replace(/\r\n/g, "");
    const g = GOLDEN_TOTALS[d.caso];
    assert(g, `caso ${d.caso} sin golden`);
    // Acepta decimales (exportación: MntExe/MntTotal son xs:decimal/4, ej. 106230.78).
    const num = (tag: string) => Number(xml.match(new RegExp(`<${tag}>(\\d+(?:\\.\\d+)?)</${tag}>`))?.[1] ?? "0");
    const reten = Number(xml.match(/<ImptoReten><TipoImp>\d+<\/TipoImp>[\s\S]*?<MontoImp>(\d+)<\/MontoImp>/)?.[1] ?? "0");
    assertEquals(num("MntNeto"), g.neto, `${d.caso} MntNeto`);
    assertEquals(num("MntExe"), g.exento, `${d.caso} MntExe`);
    assertEquals(num("IVA"), g.iva, `${d.caso} IVA`);
    assertEquals(reten, g.reten, `${d.caso} IVA retenido`);
    assertEquals(num("MntTotal"), g.total, `${d.caso} MntTotal`);
  }
});

Deno.test("DEFAULT set: NC/ND corrige-texto monto 0 → línea sin QtyItem/PrcItem", () => {
  const dtes = buildCertFacturaDtes(defaultSetArgs(), makeTestPfx(), "pass");
  for (const caso of ["4907369-5", "4907369-8", "4907375-4", "4907375-5"]) {
    const d = dtes.find((x) => x.caso === caso)!;
    const det = d.signedDte.replace(/\r\n/g, "").match(/<Detalle>[\s\S]*?<\/Detalle>/)![0];
    assert(!det.includes("<QtyItem>"), `${caso}: línea monto-0 NO debe tener QtyItem`);
    assert(!det.includes("<PrcItem>"), `${caso}: línea monto-0 NO debe tener PrcItem`);
    assertStringIncludes(det, "<MontoItem>0</MontoItem>");
  }
});

// FC 46 (factura de compra, retención total del IVA): el set NUEVO ya NO lo incluye en
// DEFAULT (escalado a mesa de ayuda — catch-22 del validador SII). El MOTOR mantiene el
// soporte (retencionTotalIva + CERT_RETEN_CODE), así que cubrimos su estructura emitiendo
// un caso 46 ad-hoc directo con buildCertFacturaDtes (no vía DEFAULT).
Deno.test("MOTOR: FC 46 retención total = estructura OFICIAL SII (línea CON <Retenedor> IndAgente=R + CodImpAdic=15, ImptoReten {15,19,IVA}, MntTotal=Neto)", () => {
  const pfx = makeTestPfx();
  const fcCase: FacturaCertCase = {
    caso: "FC46-AD-1", nroCaso: 1, tipoDocumento: 46, retencionTotalIva: true, tpoTranCompra: 1,
    items: [
      { nombre: "INSUMO AGRICOLA", cantidad: 10, precio: 1000 },
      { nombre: "INSUMO 2", cantidad: 5, precio: 2000 },
    ],
  };
  const args: BuildCertFacturaArgs = {
    cases: [fcCase],
    emisor: EMISOR_FIXT,
    receptor: { rut: "99999999-9", razonSocial: "PROVEEDOR LTDA", giro: "Insumos", dirRecep: "Ruta 5", cmnaRecep: "Talca" },
    firstFolioByType: { 46: 1 },
    cafByType: { 46: genCafXml(46) },
    fechaEmision: "2026-06-14",
    tstedIso: "2026-06-14T10:00:00",
  };
  const dtes = buildCertFacturaDtes(args, pfx, "pass");
  const d = dtes.find((x) => x.caso === "FC46-AD-1")!;
  const xml = d.signedDte.replace(/\r\n/g, "");
  assertStringIncludes(xml, "<TipoDTE>46</TipoDTE>");
  // ESTRUCTURA OFICIAL del SII (formato_retenedores.pdf + 4 XML de ejemplo del SII, 2026-06-16):
  // cada línea afecta lleva <Retenedor><IndAgente>R</IndAgente></Retenedor> (marca al EMISOR como
  // agente retenedor) + CodImpAdic=15; el header lleva ImptoReten {15,19,IVA} (retención COMPLETA)
  // + MntTotal=Neto. 🔑 El <Retenedor> es lo que faltaba en los envíos rechazados: SIN él el SII
  // espera MontoImp=[0] (HED-2-302); CON él acepta MontoImp=IVA. HED-2-260: Neto+IVA−IVA=Neto.
  const reten = Number(xml.match(/<ImptoReten><TipoImp>15<\/TipoImp><TasaImp>19<\/TasaImp><MontoImp>(\d+)<\/MontoImp><\/ImptoReten>/)?.[1] ?? "0");
  assert(reten > 0, "ImptoReten MontoImp = IVA (>0), no 0");
  assert(/<CodImpAdic>15<\/CodImpAdic>/.test(xml), "línea CON CodImpAdic=15");
  assert(/<Retenedor><IndAgente>R<\/IndAgente><\/Retenedor>/.test(xml), "línea CON <Retenedor> IndAgente=R (agente retenedor — estructura oficial SII)");
  assert(!/<CdgItem>/.test(xml), "NO debe llevar CdgItem (estructura mínima, código 15)");
  const neto = Number(xml.match(/<MntNeto>(\d+)<\/MntNeto>/)![1]);
  const iva = Number(xml.match(/<IVA>(\d+)<\/IVA>/)![1]);
  const total = Number(xml.match(/<MntTotal>(\d+)<\/MntTotal>/)![1]);
  assertEquals(neto, 10 * 1000 + 5 * 2000, "MntNeto = Σ líneas afectas");
  assertEquals(reten, iva, "MontoImp retención = IVA completo");
  assertEquals(total, neto, "MntTotal = Neto (el IVA se retiene)");
});

Deno.test("DEFAULT set: guía traslado interno sin valor (QtyItem+UnmdItem+MontoItem=0, MntTotal=0)", () => {
  const dtes = buildCertFacturaDtes(defaultSetArgs(), makeTestPfx(), "pass");
  const xml = dtes.find((x) => x.caso === "4907373-1")!.signedDte.replace(/\r\n/g, "");
  // Traslado interno NO constituye venta → sin valor comercial (estructura guía 52 real).
  assert(!xml.includes("<IVA>"), "guía de traslado interno no debe llevar IVA");
  assert(!xml.includes("<MntExe>"), "guía de traslado interno no debe llevar MntExe");
  assert(!xml.includes("<IndExe>"), "guía de traslado interno no debe llevar IndExe");
  assertStringIncludes(xml, "<IndTraslado>5</IndTraslado>");
  assert(!xml.includes("<TipoDespacho>"), "traslado interno NO debe llevar TipoDespacho");
  // Cada línea: QtyItem + UnmdItem + MontoItem=0, SIN PrcItem (set 4907373-1: cantidades 79/124/85).
  const det = xml.match(/<Detalle>[\s\S]*?<\/Detalle>/)![0];
  assertStringIncludes(det, "<QtyItem>79</QtyItem><UnmdItem>UN</UnmdItem><MontoItem>0</MontoItem>");
  assert(!det.includes("<PrcItem>"), "línea sin valor NO debe tener PrcItem");
  assertStringIncludes(xml, "<Totales><MntTotal>0</MntTotal></Totales>");
});

// ── Exportación (110/111/112): raíz <Exportaciones>, receptor extranjero, sección Aduana,
//     moneda extranjera, recargos globales, MntExe decimal sin IVA. ──

Deno.test("DEFAULT set: factura de exportación (110) usa raíz <Exportaciones>, moneda extranjera + MntExe decimal sin IVA, receptor extranjero, Aduana, FmaPagExp y recargos", () => {
  const dtes = buildCertFacturaDtes(defaultSetArgs(), makeTestPfx(), "pass");
  // 4907376-1: 110 export FRANCO SZ con flete + seguro como recargos globales (DscRcgGlobal TpoMov=R).
  const exp = dtes.find((d) => d.caso === "4907376-1")!;
  const xml = exp.signedDte.replace(/\r\n/g, "");

  // (a) raíz <Exportaciones ID= (NO <Documento>).
  assertStringIncludes(xml, '<Exportaciones ID="F1T110">');
  assert(!xml.includes("<Documento "), "el 110 NO usa raíz <Documento>");
  assertStringIncludes(xml, "<TipoDTE>110</TipoDTE>");

  // (b) Totales: TpoMoneda moneda extranjera + MntExe (sin IVA) DECIMAL (xs:decimal/4).
  assertStringIncludes(xml, "<TpoMoneda>FRANCO SZ</TpoMoneda>");
  assertStringIncludes(xml, "<MntExe>112517.5</MntExe>");
  assertStringIncludes(xml, "<MntTotal>112517.5</MntTotal>");
  assert(!xml.includes("<IVA>"), "exportación es exenta → sin IVA");
  assert(!xml.includes("<MntNeto>"), "exportación es exenta → sin MntNeto");
  // MntExe parseado como número decimal (no entero).
  const mntExe = Number(xml.match(/<MntExe>(\d+(?:\.\d+)?)<\/MntExe>/)![1]);
  assertEquals(mntExe, 112517.5);

  // (c) receptor extranjero: <Extranjero> con SOLO <Nacionalidad> (NumId es de Factura Turista,
  // TipoFactEsp=1, NO de export normal → se omite).
  assertStringIncludes(xml, "<RUTRecep>55555555-5</RUTRecep>");
  assertStringIncludes(xml, "<Extranjero><Nacionalidad>504</Nacionalidad></Extranjero>");
  assert(!xml.includes("<NumId>"), "export normal NO lleva NumId en <Extranjero>");

  // (d) sección <Aduana> con CodViaTransp, TipoBultos/CodTpoBultos, MntFlete.
  assertStringIncludes(xml, "<Aduana>");
  assertStringIncludes(xml, "<CodViaTransp>6</CodViaTransp>");
  // (d.1) Tara/Peso del bloque Aduana, en su posición XSD: ENTRE CodPtoDesemb y TotItems, con los
  // 6 campos en orden (Tara, CodUnidMedTara, PesoBruto, CodUnidPesoBruto, PesoNeto, CodUnidPesoNeto).
  // El SET 4907376-1 pide UNIDAD TARA: KN (cod 6), UNIDAD PESO BRUTO/NETO: PAR (cod 17). Sin estos
  // campos el SET-REVIEW repara SRH "Datos del Documento de Exportación No Corresponde" (2026-06-17).
  assertStringIncludes(
    xml,
    "<CodPtoDesemb>544</CodPtoDesemb><Tara>20</Tara><CodUnidMedTara>6</CodUnidMedTara><PesoBruto>700</PesoBruto><CodUnidPesoBruto>17</CodUnidPesoBruto><PesoNeto>687</PesoNeto><CodUnidPesoNeto>17</CodUnidPesoNeto><TotItems>1</TotItems>",
  );
  // TipoBultos con <Marcas> obligatorio (HED-2-804) en su posición XSD: tras CantBultos. PLANCHAS
  // (bulto 89) NO es contenedor → cierra justo tras Marcas, SIN IdContainer/Sello/EmisorSello.
  assertStringIncludes(xml, "<TipoBultos><CodTpoBultos>89</CodTpoBultos><CantBultos>69</CantBultos><Marcas>S/M</Marcas></TipoBultos>");
  assert(!xml.includes("<IdContainer>"), "PLANCHAS (4907376-1) NO es contenedor → sin IdContainer");
  assert(!xml.includes("<Sello>"), "PLANCHAS (4907376-1) NO es contenedor → sin Sello");
  assert(!xml.includes("<EmisorSello>"), "PLANCHAS (4907376-1) NO es contenedor → sin EmisorSello");
  assertStringIncludes(xml, "<MntFlete>2069.28</MntFlete>");

  // (e) FmaPagExp en IdDoc + FchCancel (obligatorio con FmaPagExp=ANTICIPO 32), tras FmaPagExp.
  assertStringIncludes(xml, "<FmaPagExp>32</FmaPagExp>");
  assertStringIncludes(xml, "<FmaPagExp>32</FmaPagExp><FchCancel>2026-06-14</FchCancel>");
  // 4907376-1 es export de BIENES (chatarra) → NO lleva IndServicio.
  assert(!xml.includes("<IndServicio>"), "export de bienes (4907376-1) NO lleva IndServicio");

  // (f) <OtraMoneda> (CLP) hermano de Totales: TpoMoneda PESO CL + TpoCambio + Mnt*OtrMnda
  // = clpRound float-safe(montos × TC). TC FRANCO SZ = 1075 → clpRound(112517.50×1075) = 120956313.
  assertStringIncludes(xml, "</Totales><OtraMoneda><TpoMoneda>PESO CL</TpoMoneda><TpoCambio>1075</TpoCambio><MntExeOtrMnda>120956313</MntExeOtrMnda><MntTotOtrMnda>120956313</MntTotOtrMnda></OtraMoneda>");

  // (g) recargos globales <DscRcgGlobal><TpoMov>R para flete y seguro (exentos), con
  // ValorDROtrMnda (= valor × TC) tras ValorDR y antes de IndExeDR (orden XSD).
  assert(/<DscRcgGlobal><NroLinDR>1<\/NroLinDR><TpoMov>R<\/TpoMov><GlosaDR>FLETE<\/GlosaDR>/.test(xml), "recargo flete TpoMov=R");
  assert(/<TpoMov>R<\/TpoMov><GlosaDR>SEGURO<\/GlosaDR>/.test(xml), "recargo seguro TpoMov=R");
  assertStringIncludes(xml, "<ValorDR>2069.28</ValorDR><ValorDROtrMnda>2224476</ValorDROtrMnda><IndExeDR>1</IndExeDR>");
  assertStringIncludes(xml, "<ValorDR>1215.22</ValorDR><ValorDROtrMnda>1306361.5</ValorDROtrMnda><IndExeDR>1</IndExeDR>");

  // (h) TED: el <MNT> del DD debe ser DECIMAL e IGUAL al <MntTotal> del DTE (112517.5),
  // NO redondeado a 112518 — si difieren el SII repara TED-3-640. El <MNT> de <Exportaciones>
  // es xs:decimal fractionDigits=4 (DTE_v10.xsd), así que el decimal es válido.
  const dd = xml.match(/<DD>[\s\S]*?<\/DD>/)![0];
  assertStringIncludes(dd, "<MNT>112517.5</MNT>");
  assert(!dd.includes("<MNT>112518</MNT>"), "el TED export NO debe redondear el MntTotal (TED-3-640)");

  // Regresión del estándar: un 33 CLP sigue con TED <MNT> ENTERO (= su MntTotal entero),
  // el cambio del decimal de export NO lo altera.
  const std33 = dtes.find((d) => d.caso === "4907369-1")!;
  const std33Xml = std33.signedDte.replace(/\r\n/g, "");
  const std33Dd = std33Xml.match(/<DD>[\s\S]*?<\/DD>/)![0];
  const std33MntTotal = std33Xml.match(/<MntTotal>(\d+)<\/MntTotal>/)![1];
  assertStringIncludes(std33Dd, `<MNT>${std33MntTotal}</MNT>`); // TED MNT == MntTotal del DTE (1683870)
  assert(!/<MNT>\d+\.\d/.test(std33Dd), "el TED de un 33 CLP NO debe llevar decimales");
});

Deno.test("DEFAULT set: NC export (112) / ND export (111) — raíz Exportaciones, exento, heredan receptor extranjero + ref al doc corregido", () => {
  const dtes = buildCertFacturaDtes(defaultSetArgs(), makeTestPfx(), "pass");
  // NC export 112 (4907376-2): devolución, exento 36411, hereda receptor extranjero del 110.
  const nc = dtes.find((d) => d.caso === "4907376-2")!;
  const ncXml = nc.signedDte.replace(/\r\n/g, "");
  assertStringIncludes(ncXml, '<Exportaciones ID="F1T112">');
  assertStringIncludes(ncXml, "<TipoDTE>112</TipoDTE>");
  assertStringIncludes(ncXml, "<TpoMoneda>FRANCO SZ</TpoMoneda>");
  assertStringIncludes(ncXml, "<MntExe>36411</MntExe>");
  assert(!ncXml.includes("<IVA>"), "NC export es exenta → sin IVA");
  // Hereda el receptor extranjero del 110: <Extranjero> con SOLO <Nacionalidad> (sin NumId).
  assertStringIncludes(ncXml, "<Extranjero><Nacionalidad>504</Nacionalidad></Extranjero>");
  assert(!ncXml.includes("<NumId>"), "NC export NO lleva NumId en <Extranjero>");
  // OtraMoneda (CLP) también en NC/ND export. TC FRANCO SZ = 1075 → round(36411×1075)=39141825.
  assertStringIncludes(ncXml, "</Totales><OtraMoneda><TpoMoneda>PESO CL</TpoMoneda><TpoCambio>1075</TpoCambio><MntExeOtrMnda>39141825</MntExeOtrMnda><MntTotOtrMnda>39141825</MntTotOtrMnda></OtraMoneda>");
  // NC export usa FmaPagExp sin anticipo → sin FchCancel.
  assert(!ncXml.includes("<FchCancel>"), "NC export sin anticipo → sin FchCancel");
  // Referencia al doc corregido (110 folio 1, CodRef 3 = devolución).
  assertStringIncludes(ncXml, "<TpoDocRef>110</TpoDocRef><FolioRef>1</FolioRef>");

  // ND export 111 (4907376-3): anula la NC export → ref a 112 folio 1, CodRef 1.
  const nd = dtes.find((d) => d.caso === "4907376-3")!;
  const ndXml = nd.signedDte.replace(/\r\n/g, "");
  assertStringIncludes(ndXml, '<Exportaciones ID="F1T111">');
  assertStringIncludes(ndXml, "<TipoDTE>111</TipoDTE>");
  assertStringIncludes(ndXml, "<TpoDocRef>112</TpoDocRef><FolioRef>1</FolioRef><FchRef>2026-06-14</FchRef><CodRef>1</CodRef>");
});

Deno.test("DEFAULT set: export YEN + DOLAR USA (4907377) — IndServicio en facturas de servicio (3/4) + OtraMoneda CLP float-safe (clpRound) + bulto TRONCOS no-contenedor", () => {
  const dtes = buildCertFacturaDtes(defaultSetArgs(), makeTestPfx(), "pass");

  // 4907377-1 ASESORIAS (servicio, YEN) → IndServicio=3, en el IdDoc tras FchEmis y antes de FmaPagExp
  // (orden XSD del subtipo Exportaciones: TipoDespacho → IndServicio → FmaPago → FmaPagExp).
  const svc1 = dtes.find((d) => d.caso === "4907377-1")!;
  const svc1Xml = svc1.signedDte.replace(/\r\n/g, "");
  assertStringIncludes(svc1Xml, '<Exportaciones ID="F2T110">');
  assertStringIncludes(svc1Xml, "<IndServicio>3</IndServicio>");
  // IndServicio precede a FmaPagExp en el IdDoc (posición XSD correcta, no rebota schema). FmaPagExp=1 (COB1).
  assertStringIncludes(svc1Xml, "<IndServicio>3</IndServicio><FmaPagExp>1</FmaPagExp>");
  // OtraMoneda CLP float-safe: clpRound(103.4×7) = round(round(10340)×7/100) = 724.
  assertStringIncludes(svc1Xml, "<MntExeOtrMnda>724</MntExeOtrMnda><MntTotOtrMnda>724</MntTotOtrMnda>");
  // El +10% por comisiones exterior va A NIVEL DE LÍNEA como <RecargoPct>10</RecargoPct> (formato_dte
  // campo 33 = flag 3/Opcional para FACT-EXPOR), con PrcItem=94 (el VALOR LINEA "especificado" del set):
  // el SII computa MontoItem = 94 × (1 + 10/100) = 103.4 (subtipo Exportaciones: PrcItem Dec12_6 / MontoItem
  // decimal/4). NO se emite <RecargoMonto> (9.4 no es positiveInteger). Glosa preservada en DscItem.
  assertStringIncludes(
    svc1Xml,
    "<NmbItem>ASESORIAS Y PROYECTOS PROFESIONALES</NmbItem><DscItem>COMISIONES EN EL EXTERIOR</DscItem><QtyItem>1</QtyItem><PrcItem>94</PrcItem><RecargoPct>10</RecargoPct><MontoItem>103.4</MontoItem>",
  );
  assertStringIncludes(svc1Xml, "<MntExe>103.4</MntExe><MntTotal>103.4</MntTotal>");
  // SIN DscRcgGlobal: el SII reparaba "El Documento Debe Tener 0 Linea(s) de Descuento/Recargo Global"
  // (el set pide el recargo EN LA LÍNEA, no global). 0 líneas de recargo global; recargo en RecargoPct.
  assert(!svc1Xml.includes("<DscRcgGlobal>"), "4907377-1 NO debe llevar DscRcgGlobal (recargo va en RecargoPct de la línea)");
  assert(svc1Xml.includes("<RecargoPct>10</RecargoPct>"), "4907377-1 lleva RecargoPct=10 a nivel de línea");
  assert(!svc1Xml.includes("<RecargoMonto>"), "4907377-1 NO usa RecargoMonto (9.4 no es positiveInteger → omitido)");
  // Una sola línea de Detalle (no se duplicó por el recargo).
  assertEquals((svc1Xml.match(/<Detalle>/g) ?? []).length, 1, "4907377-1 tiene 1 sola línea de Detalle");

  // 4907377-2 CAJAS (bienes/mercaderías, YEN) → NO lleva IndServicio. OtraMoneda clpRound(233792.38×7)=1636547.
  const goods = dtes.find((d) => d.caso === "4907377-2")!;
  const goodsXml = goods.signedDte.replace(/\r\n/g, "");
  assert(!goodsXml.includes("<IndServicio>"), "export de bienes (4907377-2) NO lleva IndServicio");
  assertStringIncludes(goodsXml, "<MntExeOtrMnda>1636547</MntExeOtrMnda><MntTotOtrMnda>1636547</MntTotOtrMnda>");
  // Tara/Peso del bloque Aduana, en su posición XSD (ENTRE CodPtoDesemb y TotItems), 6 campos en orden.
  // El SET 4907377-2 pide UNIDAD TARA/PESO BRUTO/PESO NETO: MCUB (cod 16). pesoNeto=1279=1036+243.
  assertStringIncludes(
    goodsXml,
    "<CodPtoDesemb>285</CodPtoDesemb><Tara>21</Tara><CodUnidMedTara>16</CodUnidMedTara><PesoBruto>1300</PesoBruto><CodUnidPesoBruto>16</CodUnidPesoBruto><PesoNeto>1279</PesoNeto><CodUnidPesoNeto>16</CodUnidPesoNeto><TotItems>2</TotItems>",
  );
  // TRONCOS (cod 18): bulto COMÚN, NO contenedor → cierra justo tras Marcas, SIN IdContainer/Sello/EmisorSello.
  // (El 8 que planeaba era ERRADO — no existe en la tabla CodTpoBultos; 18 = TRONCOS, verificado.)
  assertStringIncludes(goodsXml, "<TipoBultos><CodTpoBultos>18</CodTpoBultos><CantBultos>104</CantBultos><Marcas>S/M</Marcas></TipoBultos>");
  assert(!goodsXml.includes("<IdContainer>"), "TRONCOS (4907377-2) NO es contenedor → sin IdContainer");
  assert(!goodsXml.includes("<Sello>"), "TRONCOS (4907377-2) NO es contenedor → sin Sello");
  assert(!goodsXml.includes("<EmisorSello>"), "TRONCOS (4907377-2) NO es contenedor → sin EmisorSello");

  // 4907377-3 ALOJAMIENTO (servicio de hotelería, DOLAR USA) → IndServicio=4. OtraMoneda clpRound(281×950)=266950.
  const svc3 = dtes.find((d) => d.caso === "4907377-3")!;
  const svc3Xml = svc3.signedDte.replace(/\r\n/g, "");
  assertStringIncludes(svc3Xml, "<IndServicio>4</IndServicio>");
  assertStringIncludes(svc3Xml, "<MntExeOtrMnda>266950</MntExeOtrMnda><MntTotOtrMnda>266950</MntTotOtrMnda>");
  // El SII reparó "El Documento Debe Tener 2 Linea(s) de Referencia": además de la SET (auto-agregada)
  // va la 2ª referencia = RESOLUCIÓN DEL SNA (TpoDocRef 812, export de servicios), SIN CodRef. NO 813/
  // Pasaporte (el fixture de tercero quedó decomisionado). Exactamente 2 referencias.
  assertStringIncludes(svc3Xml, "<TpoDocRef>812</TpoDocRef><FolioRef>12345</FolioRef>");
  assertStringIncludes(svc3Xml, "<RazonRef>RESOLUCION SNA</RazonRef>");
  assert(!svc3Xml.includes("<TpoDocRef>813</TpoDocRef>"), "4907377-3 NO usa 813/Pasaporte");
  assertEquals((svc3Xml.match(/<Referencia>/g) ?? []).length, 2, "4907377-3 tiene 2 referencias (SET + Resolución SNA)");

  // 4907377-1 (servicio asesorías) también lleva 2ª referencia = Resolución del SNA (812), consistente
  // con el caso hermano 4907377-3 y el set ("REFERENCIA: RESOLUCION SNA").
  assertStringIncludes(svc1Xml, "<TpoDocRef>812</TpoDocRef><FolioRef>12345</FolioRef>");
  assertStringIncludes(svc1Xml, "<RazonRef>RESOLUCION SNA</RazonRef>");
});

// ── Libros (IEV / IEC / Libro de Guías) ──

Deno.test("buildCertLibros: IEV=8 docs del básico, IEC=7 fijos, Guías=3 (1 anulada)", () => {
  const dtes = buildCertFacturaDtes(defaultSetArgs(), makeTestPfx(), "pass");
  const libros = buildCertLibros(dtes, {
    emisor: EMISOR_FIXT,
    receptor: { rut: DEFAULT_FACTURA_CERT_RECEPTOR.rut, razonSocial: DEFAULT_FACTURA_CERT_RECEPTOR.razonSocial },
    rutEnvia: "22222222-2",
    fchResol: "2026-06-08",
    nroResol: 0,
    fechaEmision: "2026-06-14",
  });
  // IEV: los 8 documentos del set básico (33×4, 61×3, 56×1).
  assertEquals(libros.ventas.detalles.length, 8);
  assertEquals(libros.ventas.tipoOperacion, "VENTA");
  assertEquals(libros.ventas.periodoTributario, "2026-06");
  // IEC: 7 documentos fijos del set 4897295 + factor de uso común.
  assertEquals(libros.compras.detalles.length, 7);
  assertEquals(libros.compras.factorProporcionalidad, 0.6);
  // Libro de Guías: 3 guías; el caso 3 va anulado.
  assertEquals(libros.guias.detalles.length, 3);
  assertEquals(libros.guias.detalles.filter((d) => d.anulado !== undefined).length, 1);
  assertEquals(libros.guias.detalles.filter((d) => d.tpoOper === 5).length, 1); // traslado interno
  assertEquals(libros.guias.detalles.filter((d) => d.tpoOper === 1).length, 1); // venta facturada
});

// ── Muestras impresas (WS-8) ──

Deno.test("buildCertFacturaMuestras: 25 muestras, TED extraído, folios = emisión", () => {
  const args = defaultSetArgs();
  const pfx = makeTestPfx();
  const muestras = buildCertFacturaMuestras(args, pfx, "pass");
  const dtes = buildCertFacturaDtes(args, pfx, "pass");
  assertEquals(muestras.length, 25);
  for (const m of muestras) {
    assertStringIncludes(m.print.tedXml, "<TED");
    assertStringIncludes(m.print.tedXml, "</TED>");
    // folio de la muestra == folio del DTE emitido (mismo caso).
    const d = dtes.find((x) => x.caso === m.caso)!;
    assertEquals(m.folio, d.folio);
    assertEquals(m.print.folio, d.folio);
  }
});

Deno.test("buildCertFacturaMuestras: cedible solo 33/34 + guía venta; nunca NC/ND, guía interna ni export", () => {
  const muestras = buildCertFacturaMuestras(defaultSetArgs(), makeTestPfx(), "pass");
  const by = new Map(muestras.map((m) => [m.caso, m]));
  // Factura afecta / exenta → cedible.
  assertEquals(by.get("4907369-1")!.cedible, true); // 33 afecta
  assertEquals(by.get("4907375-1")!.cedible, true); // 34 exenta
  // Guía: interno (IndTraslado 5) NO; venta (IndTraslado 1) SÍ.
  assertEquals(by.get("4907373-1")!.cedible, false); // traslado interno
  assertEquals(by.get("4907373-2")!.cedible, true); // venta
  assertEquals(by.get("4907373-3")!.cedible, true); // venta
  // NC/ND nunca cedibles.
  assertEquals(by.get("4907369-5")!.cedible, false); // NC 61
  assertEquals(by.get("4907369-8")!.cedible, false); // ND 56
  // Exportación (110/111/112): el harness actual NO las marca cedibles (alcance vigente de
  // FacturaMuestra.cedible = 33/34/46 + guía venta). Refleja el comportamiento REAL del código.
  assertEquals(by.get("4907376-1")!.cedible, false); // 110 factura export
  assertEquals(by.get("4907376-2")!.cedible, false); // 112 NC export
  assertEquals(by.get("4907376-3")!.cedible, false); // 111 ND export
});

Deno.test("buildCertFacturaMuestras: referencias resueltas (SET + doc corregido) + guía interno receptor=emisor", () => {
  const muestras = buildCertFacturaMuestras(defaultSetArgs(), makeTestPfx(), "pass");
  const by = new Map(muestras.map((m) => [m.caso, m]));
  // NC caso 5 corrige la factura del caso 1 (33 folio 1): ref SET + ref a 33/1.
  const nc5 = by.get("4907369-5")!.print.referencias;
  assertEquals(nc5[0].tipoDocRef, "SET");
  assertEquals(nc5[0].folioRef, 5);
  assertEquals(nc5[1].tipoDocRef, "33");
  assertEquals(nc5[1].folioRef, 1);
  assertEquals(nc5[1].codRef, 2);
  // Guía interno → bandera receptorEsEmisor + tipoTraslado 5.
  assertEquals(by.get("4907373-1")!.print.receptorEsEmisor, true);
  assertEquals(by.get("4907373-1")!.print.despacho?.tipoTraslado, 5);
});

Deno.test("buildCertFacturaMuestras: exenta sin neto/iva + descuento global en totales (caso 4)", () => {
  const muestras = buildCertFacturaMuestras(defaultSetArgs(), makeTestPfx(), "pass");
  const by = new Map(muestras.map((m) => [m.caso, m]));
  // Exenta 34: neto 0, iva 0, exento > 0.
  const e1 = by.get("4907375-1")!.print.totales;
  assertEquals(e1.neto, 0);
  assertEquals(e1.iva, 0);
  assertEquals(e1.exento, 11 * 6348);
  // Caso básico-4: descuento global 7% sobre afectos.
  const c4 = by.get("4907369-4")!.print.totales;
  const afecto = 101 * 1929 + 43 * 1756;
  assertEquals(c4.descuentoGlobal, Math.round(afecto * 0.07));
  assertEquals(c4.neto, afecto - Math.round(afecto * 0.07));
});

Deno.test("buildCertFacturaMuestras: receptores distintos en facturas base + NC hereda + guía interno=emisor + export extranjero hereda", () => {
  const muestras = buildCertFacturaMuestras(defaultSetArgs(), makeTestPfx(), "pass");
  const by = new Map(muestras.map((m) => [m.caso, m]));
  // Facturas base del básico → 3 RUT distintos (inst_set: "RUT distintos").
  const f1 = by.get("4907369-1")!.print.receptor.rut;
  const f2 = by.get("4907369-2")!.print.receptor.rut;
  const f3 = by.get("4907369-3")!.print.receptor.rut;
  assert(new Set([f1, f2, f3]).size === 3, "facturas base con RUT distintos");
  assert(f1 !== EMISOR_FIXT.rut, "receptor ≠ emisor");
  // NC del caso 5 corrige la factura del caso 1 → hereda su receptor (cadena).
  assertEquals(by.get("4907369-5")!.print.receptor.rut, f1);
  // Guía de traslado interno (4907373-1) → receptor = emisor.
  assertEquals(by.get("4907373-1")!.print.receptor.rut, EMISOR_FIXT.rut);
  assertEquals(by.get("4907373-1")!.print.receptorEsEmisor, true);
  // Exportación 110 (4907376-1) → receptor extranjero (RUT genérico 55555555-5 + bloque Extranjero
  // con SOLO Nacionalidad, sin NumId); su NC export (4907376-2) HEREDA ese receptor extranjero.
  const exp1 = by.get("4907376-1")!.print.receptor;
  assertEquals(exp1.rut, "55555555-5");
  assertEquals(exp1.extranjero?.nacionalidad, 504);
  assertEquals(exp1.extranjero?.numId, undefined); // export normal NO lleva NumId
  const exp2 = by.get("4907376-2")!.print.receptor;
  assertEquals(exp2.rut, "55555555-5");
  assertEquals(exp2.extranjero?.nacionalidad, 504);
  assertEquals(exp2.extranjero?.numId, undefined);
});

Deno.test("buildCertLibroComprasDetalles: FC retención total → OtrosImp/15 (no IVARetTotal) + MntTotal=Neto + IVA uso común + entrega gratuita (IVANoRec)", () => {
  const det = buildCertLibroComprasDetalles("2026-06-14");
  assertEquals(det.length, 7);
  // FC 46 RECIBIDA con retención total: en el LIBRO DE COMPRAS la retención se informa con OtrosImp
  // CodImp=15 (IVA Retenido Total) — NO con IVARetTotal (campo del libro de VENTAS). MntIVA = IVA
  // recuperable (1995); OtrosImp/15 = IVA retenido (1995); MntTotal = Neto + IVA − retención = Neto (10498).
  // (3 SETMAIL reales 4907372 2026-06-18: IVARetTotal dio "No Informa Adecuadamente IVA Retenido Total";
  // OtrosImp/15 es el mecanismo de COMPRAS — ejemplos_libro_compras.pdf §2.1.)
  const fc = det.find((d) => d.tipoDoc === 46)!;
  assert(fc.facturaCompra === true);
  assertEquals(fc.ivaRetTotal, undefined); // NO IVARetTotal en compras (es del libro de ventas)
  assertEquals(fc.otrosImp, [{ codImp: 15, tasaImp: 19, mntImp: Math.round(10498 * 0.19) }]); // retención vía OtrosImp/15 = 1995
  assertEquals(fc.montoIva, Math.round(10498 * 0.19)); // IVA recuperable = 1995
  assertEquals(fc.montoTotal, 10498); // Neto + IVA − retención(OtrosImp 15) = Neto
  // f781: IVA uso común (el crédito 0.60 se deriva en el resumen).
  const usoComun = det.find((d) => d.folio === 781)!;
  assertEquals(usoComun.ivaUsoComun, Math.round(30122 * 0.19)); // 5723
  // f67: entrega gratuita → IVA no recuperable (CodIVANoRec=4), sin montoIva.
  const gratis = det.find((d) => d.folio === 67)!;
  assertEquals(gratis.montoIva, undefined);
  assertEquals(gratis.ivaNoRec, [{ cod: 4, monto: Math.round(11868 * 0.19) }]);
  assertEquals(gratis.montoTotal, 11868 + Math.round(11868 * 0.19));
});

Deno.test("muestras: las referencias del PAPEL calzan con las del DTE emitido (incl. aduana)", () => {
  // El SII compara la muestra impresa contra el documento que acompaña. Hasta el
  // 08-sep-2026 `buildCertFacturaMuestras` NO copiaba las referencias de ADUANA que
  // `buildCertFacturaDtes` sí pone en los casos de exportación: el papel salía con
  // menos líneas de referencia que el XML. Es exactamente la forma del reparo
  // "El Documento Debe Tener 2 Linea(s) de Referencia".
  const pfx = makeTestPfx();
  const args = defaultSetArgs();
  const dtes = buildCertFacturaDtes(args, pfx, "pass");
  const muestras = buildCertFacturaMuestras(args, pfx, "pass");

  const refsEnXml = (xml: string) => (xml.match(/<Referencia>/g) || []).length;
  const porCaso = new Map(dtes.map((d) => [d.caso, refsEnXml(d.signedDte)]));

  const desalineados: string[] = [];
  for (const m of muestras) {
    const enXml = porCaso.get(m.caso);
    if (enXml !== m.print.referencias.length) {
      desalineados.push(`${m.caso} (tipo ${m.tipoDocumento}): XML ${enXml} vs papel ${m.print.referencias.length}`);
    }
  }
  assertEquals(desalineados, [], "la muestra impresa no replica las referencias del DTE emitido");

  // Y que el caso de exportación con referencia de aduana efectivamente las lleve:
  // si el set cambiara y ninguno tuviera, este test estaría midiendo el vacío.
  const conAduana = muestras.filter((m) =>
    m.print.referencias.some((r: { tipoDocRef: string }) => /^8\d\d$/.test(r.tipoDocRef))
  );
  assert(conAduana.length > 0, "ningún caso trae referencia de aduana: el test no está probando nada");
});
