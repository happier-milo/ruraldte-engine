// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// Smoke test del render de FACTURA portado a RuralDTE (Tarea ownership fase 1).
// Verifica que generateFacturaPdf / generateFacturaSetPdf corren EN EL LAYOUT DE
// RuralDTE (imports pdf417 + sii-oficinas + assets/logo-wordmark.png resuelven) y
// producen un PDF válido para toda la familia, incluido el render VIVO del 43
// (liquidación-factura) y el 46 (factura de compra) recién traídos del box.
//
// No usa la toolchain de decodificación del timbre (pdftoppm/zxingcpp) — eso lo
// cubre el test de muestras de CR. Acá: estructura (1 página, ≤500 KB, cedible,
// X Dim ≥ 6.7 mils) + el PDF combinado del set. Escribe muestras en /tmp.
//
// Uso: node test/factura-render.mjs
import { writeFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { generateFacturaPdf, generateFacturaSetPdf } from "../src/lib/factura-pdf.mjs";

// TED de relleno (~700 B con ñ/acentos): el render sólo lo encodea en PDF417.
function makeTed(tipo, folio, rr, rsr, mnt) {
  const b64 = "MIIBnTCCAQYCQ" + "AbCd0123+/9z".repeat(12) + "==";
  return (
    `<TED version="1.0"><DD><RE>78416626-0</RE><TD>${tipo}</TD><F>${folio}</F>` +
    `<FE>2026-06-24</FE><RR>${rr}</RR><RSR>${rsr}</RSR>` +
    `<MNT>${mnt}</MNT><IT1>Artículo de prueba ñandú</IT1>` +
    `<CAF version="1.0"><DA><RE>78416626-0</RE><RS>COMUNIDAD RURAL SPA</RS>` +
    `<TD>${tipo}</TD><RNG><D>1</D><H>50</H></RNG><FA>2026-06-24</FA>` +
    `<RSAPK><M>${b64}</M><E>Aw==</E></RSAPK><IDK>100</IDK></DA>` +
    `<FRMA algoritmo="SHA1withRSA">${b64}</FRMA></CAF>` +
    `<TSTED>2026-06-24T12:00:00</TSTED></DD>` +
    `<FRMT algoritmo="SHA1withRSA">${b64}</FRMT></TED>`
  );
}

const EMISOR = {
  rut: "78416626-0",
  razonSocial: "Comunidad Rural SpA",
  giro: "Plataforma SaaS y servicios de tecnología informática",
  direccion: "Martínez de Rozas 3550 Piso 18 Depto 1808",
  comuna: "Quinta Normal", // → resolveSiiOficina → "Santiago Poniente"
  ciudad: "Santiago",
  email: "contacto@example.cl",
};
const RECEPTOR = {
  rut: "55555555-5",
  razonSocial: "CLIENTE DE PRUEBA SET SII",
  giro: "Comercio al por menor",
  direccion: "Av. Siempre Viva 742",
  comuna: "Santiago",
  ciudad: "Santiago",
};

const CASES = [
  {
    name: "33_factura_afecta",
    expectCedible: true,
    input: {
      tipoDte: 33, folio: 101, fechaEmision: "2026-06-24",
      emisor: EMISOR, siiUnidad: "Santiago Centro", receptor: RECEPTOR, cedible: true,
      items: [
        { codigo: "CAJ", nombre: "Cajón AFECTO", cantidad: 170, precio: 3581 },
        { nombre: "ITEM 3 SERVICIO EXENTO", cantidad: 1, precio: 35313, exento: true },
      ],
      totales: { neto: 608770, exento: 35313, iva: 115666, tasaIva: 19, total: 759749 },
      tedXml: makeTed(33, 101, "55555555-5", "CLIENTE DE PRUEBA SET SII", 759749),
    },
  },
  {
    name: "34_exenta",
    expectCedible: true,
    input: {
      tipoDte: 34, folio: 51, fechaEmision: "2026-06-24",
      emisor: EMISOR, siiUnidad: "Santiago Centro", receptor: RECEPTOR, cedible: true,
      items: [{ nombre: "HORAS PROGRAMADOR", cantidad: 9, precio: 5434, exento: true, unidad: "Hora" }],
      totales: { neto: 0, exento: 48906, iva: 0, total: 48906 },
      tedXml: makeTed(34, 51, "55555555-5", "CLIENTE DE PRUEBA SET SII", 48906),
    },
  },
  {
    // Liquidación-Factura 43 — el render VIVO traído del box (líneas agregadas con
    // valor explícito + comisión del mandatario en totales.valCom*).
    name: "43_liquidacion",
    expectCedible: true,
    input: {
      tipoDte: 43, folio: 9, fechaEmision: "2026-06-24",
      emisor: EMISOR, siiUnidad: "Santiago Centro", receptor: RECEPTOR, cedible: true,
      items: [
        { nombre: "NETO FACTURA ELECTRONICA 1515", cantidad: 1, valor: 387110 },
        { nombre: "EXENTO FACTURAS ELECTRONICAS", cantidad: 52, valor: 119103, exento: true },
      ],
      // valCom* = comisión del mandatario (se RESTA del total). IVAProp=valComIVA.
      totales: { neto: 387110, exento: 119103, iva: 73551, total: 575974, valComNeto: 3185, valComIVA: 605 },
      tedXml: makeTed(43, 9, "55555555-5", "MANDANTE DE PRUEBA SET SII", 575974),
    },
  },
  {
    // Factura de Compra 46 (cambio de sujeto) — la emite el comprador.
    name: "46_factura_compra",
    expectCedible: true,
    input: {
      tipoDte: 46, folio: 3, fechaEmision: "2026-06-24",
      emisor: EMISOR, siiUnidad: "Santiago Centro", receptor: RECEPTOR, cedible: true,
      items: [{ codigo: "PROD1", nombre: "Producto 1", cantidad: 500, precio: 4152 }],
      totales: { neto: 2076000, exento: 0, iva: 394440, tasaIva: 19, total: 2076000 },
      tedXml: makeTed(46, 3, "55555555-5", "PROVEEDOR DE PRUEBA SET SII", 2076000),
    },
  },
  {
    name: "61_nc_no_cedible",
    expectCedible: false,
    input: {
      tipoDte: 61, folio: 31, fechaEmision: "2026-06-24",
      emisor: EMISOR, siiUnidad: "Santiago Centro", receptor: RECEPTOR, cedible: true,
      items: [{ nombre: "Cajón AFECTO", cantidad: 170, precio: 3581 }],
      totales: { neto: 608770, exento: 0, iva: 115666, tasaIva: 19, total: 724436 },
      referencias: [
        { tipoDocRef: "33", folioRef: 101, fchRef: "2026-06-24", codRef: 1, razonRef: "ANULA FACTURA" },
      ],
      tedXml: makeTed(61, 31, "55555555-5", "CLIENTE DE PRUEBA SET SII", 724436),
    },
  },
];

let failures = 0;
const pass = (m) => console.log("  ✓", m);
const fail = (m) => {
  console.log("  ✗", m);
  failures++;
};

for (const c of CASES) {
  console.log(`\n[${c.name}]`);
  try {
    const { pdf, xDimMils, cedible } = await generateFacturaPdf(c.input);
    writeFileSync(`/tmp/fac_${c.name}.pdf`, pdf);
    const loaded = await PDFDocument.load(pdf);
    loaded.getPageCount() === 1 ? pass("1 página") : fail(`páginas = ${loaded.getPageCount()}`);
    pdf.length <= 500 * 1024
      ? pass(`tamaño ${(pdf.length / 1024).toFixed(0)} KB ≤ 500`)
      : fail(`tamaño ${(pdf.length / 1024).toFixed(0)} KB > 500 (rechazo Upload SII)`);
    cedible === c.expectCedible ? pass(`cedible = ${cedible}`) : fail(`cedible = ${cedible} (esperado ${c.expectCedible})`);
    xDimMils >= 6.7 ? pass(`X Dim ${xDimMils.toFixed(1)} mils ≥ 6.7`) : fail(`X Dim ${xDimMils.toFixed(1)} < 6.7`);
  } catch (err) {
    fail(`render lanzó: ${err?.message ?? err}`);
  }
}

// PDF combinado del set (etapa 4 cert: 1 archivo, 1 página por doc).
console.log(`\n[set_combinado]`);
try {
  const docs = CASES.map((c) => c.input);
  const { pdf, pages } = await generateFacturaSetPdf(docs);
  writeFileSync("/tmp/fac_set.pdf", pdf);
  const loaded = await PDFDocument.load(pdf);
  loaded.getPageCount() === docs.length
    ? pass(`${docs.length} páginas (1 por doc)`)
    : fail(`páginas = ${loaded.getPageCount()} (esperado ${docs.length})`);
  pages.every((p) => p.xDimMils >= 6.7) ? pass("todas las páginas X Dim ≥ 6.7") : fail("alguna página X Dim < 6.7");
  pass(`tamaño combinado ${(pdf.length / 1024).toFixed(0)} KB`);
} catch (err) {
  fail(`set lanzó: ${err?.message ?? err}`);
}

console.log(`\n${failures === 0 ? "✅ TODOS LOS CHECKS VERDES" : `❌ ${failures} checks fallaron`}`);
process.exit(failures === 0 ? 0 : 1);
