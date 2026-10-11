// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// El panel izquierdo (consumo en barras + tarifas vigentes), el teléfono de
// emergencias, y lo que no se negocia: el timbre se dibuja entero y nada lo
// tapa, por larga que sea la boleta.
//
// Antes de este test una boleta con muchas filas (tarjeta de datos de diez
// filas, cinco tramos, subsidio, saldo anterior) dibujaba la franja de
// vencimiento ENCIMA del timbre, sin error.
//
//   node --test test/panel-y-cabe-en-la-hoja.test.mjs
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { generateBoletaElectronicaPdf, NIVEL_SEGUNDA_HOJA } from "../src/lib/boleta-pdf.mjs";
import { extractPdfText } from "./_pdf-text.mjs";

const b64 = "MIIBnTCCAQYCQ" + "AbCd0123+/9z".repeat(13) + "==";
const TED =
  `<TED version="1.0"><DD><RE>55555555-5</RE><TD>41</TD><F>44595</F>` +
  `<FE>2025-03-01</FE><RR>12345678-9</RR><RSR>SOCIA DE PRUEBA</RSR>` +
  `<MNT>10300</MNT><IT1>Consumo de agua potable</IT1>` +
  `<CAF version="1.0"><DA><RE>55555555-5</RE><RS>COMITE APR</RS>` +
  `<TD>41</TD><RNG><D>44000</D><H>45000</H></RNG><FA>2025-01-01</FA>` +
  `<RSAPK><M>${b64}</M><E>Aw==</E></RSAPK><IDK>300</IDK></DA>` +
  `<FRMA algoritmo="SHA1withRSA">${b64}</FRMA></CAF>` +
  `<TSTED>2025-03-01T09:00:00</TSTED></DD>` +
  `<FRMT algoritmo="SHA1withRSA">${b64}</FRMT></TED>`;

const BASE = {
  tipoDte: 41,
  folio: 44595,
  fechaEmision: "2025-03-01",
  emisor: { rut: "55555555-5", razonSocial: "Comité de Agua Potable Rural de Prueba", giro: "Servicio de agua potable rural", direccion: "Camino Principal s/n", region: "Valparaíso" },
  receptor: { rut: "12345678-9", nombre: "Socia de Prueba", direccion: "Los Aromos 485" },
  periodo: "Febrero 2025",
  medidor: "5531",
  lectura: { anterior: 1439, actual: 1447, consumo: 8, tarifa: 850, unidad: "m³", fechaAnterior: "2025-01-20", fechaActual: "2025-02-20" },
  items: [{ nombre: "Consumo agua potable rural", cantidad: 1, precio: 10300 }],
  totales: { exento: 10300, total: 10300 },
  vencimiento: "2025-03-28",
  tedXml: TED,
};

const DATOS = [
  { label: "Calidad", valor: "Socio" },
  { label: "N° de servicio", valor: "485" },
  { label: "Tipo de facturación", valor: "Normal" },
  { label: "Diámetro del medidor", valor: '1/2"' },
  { label: "Sector", valor: "LOS AROMOS" },
  { label: "Consumo promedio últimos 3 meses", valor: "9,3 m³" },
  { label: "Próxima lectura (estimada)", valor: "20/03/2025" },
];
const HISTORIAL = {
  titulo: "Tu consumo, últimos 12 meses",
  unidad: "m³",
  puntos: ["mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic", "ene", "feb"]
    .map((etiqueta, i) => ({ etiqueta, valor: [14, 12, 9.5, 7, 6, 0, 5, 8, 11, 12, 9, 8][i] })),
};
const TARIFARIO = {
  titulo: "Tarifas vigentes",
  filas: [
    { label: 'Cargo fijo, medidor de 1/2"', valor: "$ 3.500" },
    { label: 'Cargo fijo, medidor de 3/4"', valor: "$ 4.500" },
    { label: "0 a 20 m³, por m³", valor: "$ 850" },
    { label: "Más de 60 m³, por m³", valor: "$ 6.000" },
  ],
};
const fila = (i) => ({ label: `Concepto de prueba ${i}`, valor: "$ 1.000", sub: "detalle del concepto" });

const render = async (representacion) => {
  const out = await generateBoletaElectronicaPdf({ ...BASE, representacion });
  const doc = await PDFDocument.load(out.pdf);
  return { ...out, texto: extractPdfText(out.pdf), hojas: doc.getPageCount() };
};

test("el gráfico de consumo y las tarifas vigentes salen impresos", async () => {
  const con = await render({ datos: DATOS, historial: HISTORIAL, tarifario: TARIFARIO });
  assert.match(con.texto, /Tu consumo, últimos 12 meses/);
  assert.match(con.texto, /feb/);
  assert.match(con.texto, /9,5/); // el valor va sobre su barra
  assert.match(con.texto, /Tarifas vigentes/);
  assert.match(con.texto, /Cargo fijo, medidor de 3\/4"/);
  assert.match(con.texto, /Más de 60 m³, por m³/);
  // Con el panel completo puede ceder aire entre secciones, nunca contenido.
  assert.ok(con.nivel <= 1, `nivel ${con.nivel}`);
  assert.equal(con.hojas, 1);

  // Control: sin los bloques, no hay nada de eso en el papel.
  const sin = await render({ datos: DATOS });
  assert.doesNotMatch(sin.texto, /Tu consumo/);
  assert.doesNotMatch(sin.texto, /Tarifas vigentes/);
});

test("un solo punto no es un gráfico", async () => {
  const r = await render({ historial: { titulo: "Tu consumo", puntos: [{ etiqueta: "feb", valor: 8 }] } });
  assert.doesNotMatch(r.texto, /Tu consumo/);
});

test("el teléfono de emergencias va en su línea, y sin él el de atención sirve para las dos cosas", async () => {
  const dos = await render({ contacto: { fono: "+56 33 244 1111", horario: "L a V 9 a 13", emergencia: "+56 9 8888 8888" } });
  assert.match(dos.texto, /Atención de usuarios/);
  assert.match(dos.texto, /Emergencias/);
  assert.match(dos.texto, /\+56 9 8888 8888/);
  const uno = await render({ contacto: { fono: "+56 33 244 1111", horario: "L a V 9 a 13" } });
  assert.match(uno.texto, /Atención y emergencias/);
  assert.doesNotMatch(uno.texto, /Atención de usuarios/);
});

test("con muchos datos, todas las filas se imprimen igual (repartidas entre las dos tarjetas)", async () => {
  const r = await render({ datos: DATOS });
  for (const d of DATOS) assert.ok(r.texto.includes(d.label), `falta ${d.label}`);
});

test("una boleta larga se aprieta antes de soltar nada, y sigue en una hoja", async () => {
  const r = await render({
    datos: DATOS,
    historial: HISTORIAL,
    tarifario: TARIFARIO,
    bloques: [{ filas: [1, 2, 3, 4, 5, 6, 7, 8].map(fila).concat([{ label: "TOTAL", valor: "$ 8.000", enfasis: true }]) }],
  });
  assert.equal(r.hojas, 1);
  assert.ok(r.nivel >= 1 && r.nivel < NIVEL_SEGUNDA_HOJA, `nivel ${r.nivel}`);
  assert.match(r.texto, /Timbre Electrónico SII/);
  assert.match(r.texto, /Vence/);
});

test("lo que no cabe ni apretado pasa el timbre y el pie a una segunda hoja, completos", async () => {
  const r = await render({
    datos: DATOS,
    historial: HISTORIAL,
    tarifario: TARIFARIO,
    bloques: [{ filas: Array.from({ length: 24 }, (_, i) => fila(i + 1)) }],
    notas: ["Nota uno", "Nota dos", "Nota tres", "Nota cuatro"],
  });
  assert.equal(r.nivel, NIVEL_SEGUNDA_HOJA);
  assert.equal(r.hojas, 2);
  assert.match(r.texto, /Timbre Electrónico SII/);
  assert.match(r.texto, /Vence/);
  // Las 24 filas siguen en el papel: no se suelta un cargo para hacer espacio.
  assert.match(r.texto, /Concepto de prueba 24/);
});

test("una boleta corriente no cambia de nivel: sale como siempre", async () => {
  const r = await render({ datos: DATOS.slice(0, 3), bloques: [{ filas: [fila(1), fila(2)] }] });
  assert.equal(r.nivel, 0);
  assert.equal(r.hojas, 1);
});
