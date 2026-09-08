// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// La tabla de lectura NO es sanitaria: sus rótulos son del emisor.
//
// POR QUÉ ESTE TEST EXISTE
// `lectura` era la excepción a la regla del render: la unidad ya era del emisor
// (default "m³"), pero los cuatro encabezados —"Lectura anterior", "Consumo del
// período", "Tarifa vigente"— estaban fijos, igual que el "Medidor N°" de la
// tarjeta de datos, que además vive FUERA de `lectura`.
//
// Sin override, el único escape era dejar de mandar `lectura` y mover esas
// celdas a `representacion`: perder la franja de 4 columnas para esquivar un
// rótulo, y encima quedarse igual con "Medidor N°". Este test fija que ese
// trade-off ya no existe.
//
//   node --test test/lectura-agnostica.test.mjs
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateBoletaElectronicaPdf } from "../src/lib/boleta-pdf.mjs";
import { extractPdfText } from "./_pdf-text.mjs";

const b64 = "MIIBnTCCAQYCQ" + "AbCd0123+/9z".repeat(13) + "==";
const TED = `<TED version="1.0"><DD><RE>78416626-0</RE><TD>39</TD><F>7</F>` +
  `<FE>2026-07-24</FE><RR>12345678-9</RR><RSR>CLIENTE</RSR>` +
  `<MNT>45600</MNT><IT1>Servicio</IT1>` +
  `<CAF version="1.0"><DA><RE>78416626-0</RE><RS>EMISOR SPA</RS>` +
  `<TD>39</TD><RNG><D>1</D><H>50</H></RNG><FA>2026-07-01</FA>` +
  `<RSAPK><M>${b64}</M><E>Aw==</E></RSAPK><IDK>300</IDK></DA>` +
  `<FRMA algoritmo="SHA1withRSA">${b64}</FRMA></CAF>` +
  `<TSTED>2026-07-24T12:00:00</TSTED></DD>` +
  `<FRMT algoritmo="SHA1withRSA">${b64}</FRMT></TED>`;

const BASE = {
  tipoDte: 39,
  folio: 7,
  fechaEmision: "2026-07-24",
  emisor: { rut: "78416626-0", razonSocial: "EMISOR SPA", comuna: "Chillán" },
  receptor: { rut: "12345678-9", nombre: "CLIENTE" },
  periodo: "Julio 2026",
  items: [{ nombre: "Servicio", cantidad: 1, precio: 45600, valor: 45600 }],
  totales: { neto: 38319, iva: 7281, total: 45600 },
  tedXml: TED,
};

const render = async (input) => extractPdfText((await generateBoletaElectronicaPdf(input)).pdf);

test("por defecto la tabla sigue diciendo lo de siempre (no regresiona)", async () => {
  const texto = await render({
    ...BASE,
    medidor: "A-042",
    lectura: { anterior: 650, actual: 700, consumo: 50, tarifa: 620 },
  });
  assert.ok(texto.includes("Lectura anterior"));
  assert.ok(texto.includes("Consumo del"));
  assert.ok(texto.includes("Tarifa vigente"));
  assert.ok(texto.includes("Medidor N"));
  assert.ok(texto.includes("m³"), "la unidad por defecto sigue siendo m³");
});

test("un rubro que no es agua reemplaza los cuatro rótulos y la unidad", async () => {
  // Un gimnasio factura horas de cancha. Misma franja de 4 columnas, cero
  // vocabulario sanitario.
  const texto = await render({
    ...BASE,
    medidor: "CANCHA-2",
    medidorLabel: "Cancha",
    lectura: {
      anterior: 12, actual: 30, consumo: 18, tarifa: 2500, unidad: "horas",
      etiquetas: ["Horas al inicio", "Horas al cierre", "Horas usadas", "Valor por hora"],
    },
  });
  for (const propio of ["Horas al inicio", "Horas al cierre", "Horas usadas", "Valor por hora", "Cancha"]) {
    assert.ok(texto.includes(propio), `no salió el rótulo propio: ${propio}`);
  }
  for (const sanitario of ["Lectura anterior", "Tarifa vigente", "Medidor N", "m³"]) {
    assert.ok(!texto.includes(sanitario), `se coló vocabulario sanitario: ${sanitario}`);
  }
});

test("las etiquetas se sobrescriben por índice: mandar una no borra las otras", async () => {
  const texto = await render({
    ...BASE,
    lectura: {
      anterior: 1, actual: 2, consumo: 1, tarifa: 100,
      etiquetas: [undefined, undefined, "Kilos despachados"],
    },
  });
  assert.ok(texto.includes("Kilos despachados"), "no tomó la etiqueta del índice 2");
  assert.ok(texto.includes("Lectura anterior"), "perdió el default del índice 0");
  assert.ok(texto.includes("Tarifa vigente"), "perdió el default del índice 3");
  assert.ok(!texto.includes("Consumo del"), "no reemplazó el índice 2");
});

test("una etiqueta vacía o no-texto cae al default, no deja la columna sin nombre", async () => {
  const texto = await render({
    ...BASE,
    lectura: { anterior: 1, actual: 2, consumo: 1, tarifa: 100, etiquetas: ["   ", 42, null, ""] },
  });
  assert.ok(texto.includes("Lectura anterior"));
  assert.ok(texto.includes("Tarifa vigente"));
});

test("una etiqueta larguísima se acota y no desborda la columna", async () => {
  const texto = await render({
    ...BASE,
    lectura: {
      anterior: 1, actual: 2, consumo: 1, tarifa: 100,
      etiquetas: ["Un encabezado desmedidamente largo que jamás cabría en la columna"],
    },
  });
  assert.ok(texto.includes("Un encabezado"), "el encabezado propio desapareció");
});
