// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// La línea "S.I.I. — <Unidad>" bajo el recuadro rojo (manual de muestras
// impresas: Dirección Regional/Unidad con jurisdicción sobre la comuna del
// emisor) se resuelve siiUnidad > oficina-por-comuna > comuna. Si el emisor no
// trae comuna (emisores.comuna era nullable; probe E2E 2026-07-03) la línea se
// omite COMPLETA — nunca un "S.I.I. —" colgando. La boleta conserva su "DTE NN".
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { generateFacturaPdf } from "../src/lib/factura-pdf.mjs";
import { generateBoletaElectronicaPdf } from "../src/lib/boleta-pdf.mjs";

const TED_FAKE = "<TED version=\"1.0\"><DD><RE>77123456-7</RE><TD>33</TD><F>1</F>" +
  "<FE>2026-07-03</FE><MNT>119000</MNT></DD><FRMT algoritmo=\"SHA1withRSA\">x</FRMT></TED>";

// Texto plano de los content streams del PDF (pdf-lib comprime con Flate y
// escribe los strings como literales "(…) Tj" o hex "<…> Tj" según la fuente).
function pdfText(pdfBytes) {
  const latin = Buffer.from(pdfBytes).toString("latin1");
  let streams = "";
  // (?<!end): no re-matchear el "stream\n" que vive dentro de "endstream\n".
  const re = /(?<!end)stream\r?\n/g;
  let m;
  while ((m = re.exec(latin)) !== null) {
    const end = latin.indexOf("endstream", re.lastIndex);
    if (end === -1) break;
    const body = Buffer.from(latin.slice(re.lastIndex, end), "latin1");
    try {
      const inflated = zlib.inflateSync(body).toString("latin1");
      if (inflated.includes("Tj") || inflated.includes("TJ")) streams += inflated;
    } catch {
      if (body.includes("Tj")) streams += body.toString("latin1");
    }
    re.lastIndex = end + "endstream".length;
  }
  const parts = [];
  for (const lit of streams.match(/\((?:[^()\\]|\\.)*\)\s*Tj/g) ?? []) {
    parts.push(lit.replace(/\)\s*Tj$/, "").slice(1).replace(/\\([()\\])/g, "$1"));
  }
  for (const hex of streams.match(/<[0-9A-Fa-f\s]+>\s*Tj/g) ?? []) {
    const clean = hex.replace(/[^0-9A-Fa-f]/g, "");
    let s = "";
    for (let i = 0; i + 1 < clean.length; i += 2) s += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
    parts.push(s);
  }
  return parts.join("\n");
}

const facturaInput = (emisor, extra = {}) => ({
  tipoDte: 33,
  folio: 1,
  fechaEmision: "2026-07-03",
  emisor,
  receptor: { rut: "76543210-K", razonSocial: "Cliente de Prueba SpA" },
  items: [{ nombre: "Servicio", cantidad: 1, precio: 100000 }],
  totales: { neto: 100000, iva: 19000, exento: 0, total: 119000 },
  tedXml: TED_FAKE,
  ...extra,
});

const boletaInput = (emisor, extra = {}) => ({
  tipoDte: 39,
  folio: 42,
  fechaEmision: "2026-07-03",
  emisor,
  items: [{ nombre: "Venta del día", cantidad: 1, precio: 11900 }],
  totales: { neto: 10000, iva: 1900, total: 11900 },
  tedXml: TED_FAKE,
  ...extra,
});

test("factura con comuna imprime S.I.I. — <oficina con jurisdicción>", async () => {
  const { pdf } = await generateFacturaPdf(
    facturaInput({ rut: "77123456-7", razonSocial: "Almacén Rural Ltda", comuna: "Maullín" }),
  );
  const text = pdfText(pdf);
  assert.ok(text.includes("S.I.I."), "debe llevar la línea S.I.I.");
  assert.ok(text.includes("PUERTO MONTT"), "Maullín pertenece a la unidad Puerto Montt");
});

test("factura sin comuna omite la línea S.I.I. completa (sin prefijo colgando)", async () => {
  const { pdf } = await generateFacturaPdf(
    facturaInput({ rut: "77123456-7", razonSocial: "Almacén Rural Ltda" }),
  );
  const text = pdfText(pdf);
  assert.ok(text.includes("FACTURA"), "sanity: el PDF sí tiene texto extraíble");
  assert.ok(!text.includes("S.I.I."), "sin unidad no debe imprimirse ni el prefijo S.I.I. —");
});

test("factura sin comuna pero con siiUnidad explícita sí lleva la línea", async () => {
  const { pdf } = await generateFacturaPdf(
    facturaInput({ rut: "77123456-7", razonSocial: "Almacén Rural Ltda" }, { siiUnidad: "Santiago Oriente" }),
  );
  const text = pdfText(pdf);
  assert.ok(text.includes("S.I.I."));
  assert.ok(text.includes("SANTIAGO ORIENTE"));
});

test("boleta con comuna imprime S.I.I. — <oficina> · DTE 39", async () => {
  const { pdf } = await generateBoletaElectronicaPdf(
    boletaInput({ rut: "77123456-7", razonSocial: "Almacén Rural Ltda", comuna: "Quinta Normal" }),
  );
  const text = pdfText(pdf);
  assert.ok(text.includes("S.I.I."));
  assert.ok(text.includes("SANTIAGO PONIENTE"), "Quinta Normal pertenece a Santiago Poniente");
  assert.ok(text.includes("DTE 39"));
});

test("boleta sin comuna: omite el S.I.I. — pero conserva el DTE 39", async () => {
  const { pdf } = await generateBoletaElectronicaPdf(
    boletaInput({ rut: "77123456-7", razonSocial: "Almacén Rural Ltda" }),
  );
  const text = pdfText(pdf);
  assert.ok(!text.includes("S.I.I."), "sin unidad no debe imprimirse el prefijo S.I.I. —");
  assert.ok(text.includes("DTE 39"), "el tipo de documento se conserva");
});
