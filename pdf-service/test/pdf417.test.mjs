// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// Tests del Componente E (timbre PDF417 + boleta PDF). Autocontenido:
// codifica con zxing-wasm/writer y decodifica con zxing-wasm/reader (sin python).
//   node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readBarcodes } from "zxing-wasm/reader";
import {
  buildTedPdf417,
  encodeTedBarcode,
  fitTimbre,
  toLatin1Bytes,
} from "../src/lib/pdf417.mjs";
import { generateBoletaElectronicaPdf } from "../src/lib/boleta-pdf.mjs";

// TED de prueba con acentos AISLADOS (el caso que rompe text-compaction).
const b64 = "MIIBnTCCAQYCQ" + "AbCd0123+/9z".repeat(13) + "==";
const TED = (td) =>
  `<TED version="1.0"><DD><RE>78416626-0</RE><TD>${td}</TD><F>3</F>` +
  `<FE>2026-06-10</FE><RR>12345678-9</RR><RSR>JOSÉ ÑUÑEZ PÉREZ</RSR>` +
  `<MNT>29800</MNT><IT1>Cañería</IT1>` +
  `<CAF version="1.0"><DA><RE>78416626-0</RE><RS>APR ÑUBLE</RS>` +
  `<TD>${td}</TD><RNG><D>1</D><H>5</H></RNG><FA>2026-06-08</FA>` +
  `<RSAPK><M>${b64}</M><E>Aw==</E></RSAPK><IDK>300</IDK></DA>` +
  `<FRMA algoritmo="SHA1withRSA">${b64}</FRMA></CAF>` +
  `<TSTED>2026-06-10T12:00:00</TSTED></DD>` +
  `<FRMT algoritmo="SHA1withRSA">${b64}</FRMT></TED>`;

test("toLatin1Bytes mapea code points 0-255 a su byte (Ñ → 0xD1)", () => {
  const b = toLatin1Bytes("SEÑOR");
  assert.equal(b.length, 5);
  assert.equal(b[2], 0xd1);
});

test("PDF417 byte-mode: el TED con acentos round-trippea byte-a-byte", async () => {
  const ted = TED(39);
  const res = await encodeTedBarcode(ted);
  assert.ok(res.image, "writer devuelve PNG");
  const decoded = await readBarcodes(res.image, { formats: ["PDF417"], tryHarder: true });
  assert.equal(decoded.length, 1, "se decodifica el símbolo");
  const got = Buffer.from(decoded[0].bytes);
  const want = Buffer.from(toLatin1Bytes(ted));
  assert.equal(Buffer.compare(got, want), 0, "bytes decodificados == TED original");
});

test("buildTedPdf417 devuelve geometría vectorial usable", async () => {
  const { width, height, path } = await buildTedPdf417(TED(41));
  assert.ok(width > 0 && height > 0, "dimensiones positivas");
  assert.ok(path.startsWith("M"), "path SVG (moveto)");
  assert.ok(width > height, "PDF417 más ancho que alto");
});

test("fitTimbre respeta la envolvente SII (≤9cm×3cm, X Dim ≥ 6.7 mils)", async () => {
  const bc = await buildTedPdf417(TED(39));
  const fit = fitTimbre(bc);
  assert.ok(fit.drawW <= 9 * (72 / 2.54) + 0.5, "ancho ≤ 9 cm");
  assert.ok(fit.drawH <= 3 * (72 / 2.54) + 0.5, "alto ≤ 3 cm");
  assert.ok(fit.xDimMils >= 6.7, `X Dim ${fit.xDimMils.toFixed(1)} ≥ 6.7 mils`);
});

for (const tipo of [39, 41]) {
  test(`generateBoletaElectronicaPdf(${tipo}) produce un PDF válido`, async () => {
    const { pdf, xDimMils } = await generateBoletaElectronicaPdf({
      tipoDte: tipo,
      folio: 3,
      fechaEmision: "2026-06-10",
      emisor: { rut: "78416626-0", razonSocial: "APR ÑUBLE", giro: "Agua rural", comuna: "Chillán" },
      receptor: { rut: "12345678-9", nombre: "JOSÉ ÑUÑEZ PÉREZ" },
      items: [{ nombre: "Servicio", cantidad: 1, precio: 29800 }],
      totales: tipo === 41
        ? { exento: 29800, total: 29800 }
        : { neto: 25042, iva: 4758, total: 29800 },
      tedXml: TED(tipo),
    });
    assert.ok(pdf.length > 1000, "PDF no vacío");
    assert.equal(Buffer.from(pdf.slice(0, 5)).toString(), "%PDF-", "cabecera PDF");
    assert.ok(xDimMils >= 6.7, "X Dim ≥ 6.7 mils");
  });
}

test("boleta agua completa (lectura + medidor + vencimiento + EJEMPLO) compila y es X-Dim compliant", async () => {
  const { pdf, xDimMils } = await generateBoletaElectronicaPdf({
    tipoDte: 41,
    folio: 1048,
    fechaEmision: "2026-06-01",
    emisor: { rut: "65432109-8", razonSocial: "COMITE APR LOS AROMOS", giro: "Agua rural", comuna: "Paine" },
    receptor: { rut: "12345678-9", nombre: "JUANA PÉREZ SOTO", direccion: "Parcela 12, sector Los Aromos" },
    periodo: "Mayo 2026",
    medidor: "A-042",
    lectura: { anterior: 1250, actual: 1264, consumo: 14, tarifa: 390, unidad: "m³" },
    items: [
      { nombre: "Cargo fijo mensual", cantidad: 1, precio: 3200 },
      { nombre: "Consumo de agua potable", cantidad: 14, precio: 390, valor: 5460 },
    ],
    totales: { exento: 8660, total: 8660 },
    vencimiento: "2026-06-15",
    resolucion: "Res. 80 del 2014",
    watermark: "DEMO",
    tedXml: TED(41),
  });
  assert.equal(Buffer.from(pdf.slice(0, 5)).toString(), "%PDF-");
  assert.ok(xDimMils >= 6.7, `X Dim ${xDimMils.toFixed(1)} ≥ 6.7`);
});
