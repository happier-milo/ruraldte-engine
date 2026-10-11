// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// Cómo pagar, cuánto hay que pagar, y el nombre del emisor.
//
// Tres cosas que la boleta impresa hacía mal y que se ven al tenerla en la mano:
//   · no decía a qué cuenta transferir ni qué escribir en la transferencia;
//   · con un saldo anterior o la cuota de un convenio decía "TOTAL A PAGAR" dos
//     veces, con dos montos (el de la suma y el del documento);
//   · un nombre largo ("Comité de Agua Potable Rural Quebrada Imaginaria") se
//     escribía encima del recuadro rojo del RUT.
//
//   node --test test/como-pagar-y-total.test.mjs
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { generateBoletaElectronicaPdf, NIVEL_SEGUNDA_HOJA } from "../src/lib/boleta-pdf.mjs";
import { extractPdfLines, extractPdfText } from "./_pdf-text.mjs";

const b64 = "MIIBnTCCAQYCQ" + "AbCd0123+/9z".repeat(13) + "==";
const TED =
  `<TED version="1.0"><DD><RE>55555555-5</RE><TD>41</TD><F>44595</F>` +
  `<FE>2026-10-01</FE><RR>12345678-9</RR><RSR>SOCIA DE PRUEBA</RSR>` +
  `<MNT>15450</MNT><IT1>Consumo de agua potable</IT1>` +
  `<CAF version="1.0"><DA><RE>55555555-5</RE><RS>COMITE APR</RS>` +
  `<TD>41</TD><RNG><D>44000</D><H>45000</H></RNG><FA>2026-01-01</FA>` +
  `<RSAPK><M>${b64}</M><E>Aw==</E></RSAPK><IDK>300</IDK></DA>` +
  `<FRMA algoritmo="SHA1withRSA">${b64}</FRMA></CAF>` +
  `<TSTED>2026-10-01T09:00:00</TSTED></DD>` +
  `<FRMT algoritmo="SHA1withRSA">${b64}</FRMT></TED>`;

const BASE = {
  tipoDte: 41,
  folio: 44595,
  fechaEmision: "2026-10-01",
  emisor: { rut: "55555555-5", razonSocial: "Comité APR de Prueba", giro: "Servicio de agua potable rural", direccion: "Camino Principal s/n", region: "Valparaíso" },
  receptor: { rut: "12345678-9", nombre: "Socia de Prueba", direccion: "Los Aromos 485" },
  periodo: "Septiembre 2026",
  medidor: "5531",
  lectura: { anterior: 1439, actual: 1457, consumo: 18, tarifa: 850, unidad: "m³" },
  items: [{ nombre: "Consumo agua potable rural", cantidad: 1, precio: 15450 }],
  totales: { exento: 15450, total: 15450 },
  vencimiento: "2026-10-28",
  tedXml: TED,
};

const PAGO = {
  titulo: "Pago por transferencia",
  lineas: [
    "Banco Estado · Cuenta corriente N° 123456789",
    "Comité de Agua Potable Rural de Prueba",
    "RUT 55.555.555-5 · En el mensaje escribe tu N° de servicio: 485",
  ],
};
const CARGOS = {
  filas: [
    { label: "Cargo fijo", valor: "$ 3.500" },
    { label: "Consumo 0 a 15 m³", valor: "$ 12.750", sub: "15 m³ x $ 850" },
  ],
};

const render = async (representacion, extra = {}) => {
  const out = await generateBoletaElectronicaPdf({ ...BASE, ...extra, representacion });
  const doc = await PDFDocument.load(out.pdf);
  return { ...out, texto: extractPdfText(out.pdf), lineas: extractPdfLines(out.pdf), hojas: doc.getPageCount() };
};
const veces = (texto, que) => texto.split(que).length - 1;

test("la cuenta para transferir sale impresa, y no le quita alto a la boleta", async () => {
  const con = await render({ bloques: [CARGOS], pago: PAGO });
  assert.match(con.texto, /Pago por transferencia/);
  assert.match(con.texto, /Banco Estado · Cuenta corriente N° 123456789/);
  assert.match(con.texto, /Comité de Agua Potable Rural de Prueba/);
  assert.match(con.texto, /En el mensaje escribe tu N° de servicio: 485/);
  assert.equal(con.hojas, 1);

  // Control: sin el bloque no hay nada de eso, y la boleta ocupa lo mismo.
  const sin = await render({ bloques: [CARGOS] });
  assert.doesNotMatch(sin.texto, /Pago por transferencia/);
  assert.doesNotMatch(sin.texto, /Cuenta corriente/);
  assert.equal(con.nivel, sin.nivel);
});

test("sin líneas no se dibuja un recuadro vacío con su título", async () => {
  const vacio = await render({ bloques: [CARGOS], pago: { titulo: "Pago por transferencia", lineas: ["", "  "] } });
  assert.doesNotMatch(vacio.texto, /Pago por transferencia/);
  const sinLista = await render({ bloques: [CARGOS], pago: { titulo: "Pago por transferencia" } });
  assert.doesNotMatch(sinLista.texto, /Pago por transferencia/);
});

test("una línea que no cabe se parte en dos, completa", async () => {
  const larga = "A nombre de la Cooperativa de Servicio de Agua Potable y Saneamiento Rural de Prueba Limitada, RUT 55.555.555-5";
  const con = await render({ pago: { titulo: "Pago por transferencia", lineas: [larga] } });
  // Entera en una sola línea no cabe en el recuadro: se dibuja en más de una…
  assert.ok(!con.lineas.includes(larga));
  const partes = con.lineas.filter((l) => larga.includes(l) && l.length > 20);
  assert.ok(partes.length >= 2, `se dibujó en ${partes.length} líneas`);
  // …y no se pierde ninguna palabra.
  assert.equal(partes.join(" "), larga);
  assert.equal(con.hojas, 1);
});

test("con saldo anterior hay UN solo total a pagar, y es la suma", async () => {
  const con = await render({
    bloques: [CARGOS],
    totalAPagar: {
      valor: "$ 23.450",
      filas: [
        { label: "Convenio de pago · cuota 2/6", valor: "$ 3.000" },
        { label: "Saldo anterior", valor: "$ 5.000" },
      ],
    },
  });
  assert.equal(veces(con.texto, "TOTAL A PAGAR"), 1);
  assert.match(con.texto, /Total de esta boleta/);
  assert.match(con.texto, /Saldo anterior/);
  assert.match(con.texto, /Convenio de pago · cuota 2\/6/);
  // La suma va en el número grande y en la franja de vencimiento.
  assert.equal(veces(con.texto, "$ 23.450"), 2);
  // El total del documento sigue en la hoja: es lo que se declara.
  assert.ok(veces(con.texto, "$ 15.450") >= 1);

  // Control: sin saldo ni convenio, el total a pagar es el del documento.
  const sin = await render({ bloques: [CARGOS] });
  assert.equal(veces(sin.texto, "TOTAL A PAGAR"), 1);
  assert.doesNotMatch(sin.texto, /Total de esta boleta/);
  assert.doesNotMatch(sin.texto, /23\.450/);
  // En el número grande y en la franja.
  assert.ok(veces(sin.texto, "$ 15.450") >= 2);
});

test("un total a pagar sin valor no cambia nada", async () => {
  const con = await render({ bloques: [CARGOS], totalAPagar: { valor: "", filas: [{ label: "Saldo anterior", valor: "$ 5.000" }] } });
  assert.doesNotMatch(con.texto, /Total de esta boleta/);
  assert.doesNotMatch(con.texto, /Saldo anterior/);
});

test("un nombre largo del emisor va en dos líneas y no se escribe sobre el recuadro del RUT", async () => {
  const nombre = "Comité de Agua Potable Rural Quebrada Imaginaria";
  const largo = await render({}, { emisor: { ...BASE.emisor, razonSocial: nombre } });
  // Entero en una línea no cabe a la izquierda del recuadro: se parte.
  assert.ok(!largo.lineas.includes(nombre));
  assert.ok(largo.lineas.includes("Comité de Agua Potable Rural Quebrada"));
  assert.ok(largo.lineas.includes("Imaginaria"));

  // Control: uno corto sale como siempre, en una línea.
  const corto = await render({});
  assert.ok(corto.lineas.includes("Comité APR de Prueba"));
});

// La boleta más cargada que arma hoy un comité de agua: nombre largo, tres
// teléfonos, ocho datos, dos tramos, subsidio, saldo anterior, convenio, el
// gráfico de doce meses, la tabla de tarifas, una nota y la cuenta para
// transferir. Antes de tener nivel de interlínea mínima se pasaba por menos de un
// punto y se iba a dos hojas, con mil doscientas boletas que imprimir.
const CARGADA = {
  contacto: { fono: "+56 9 1234 5678", horario: "Lunes a viernes de 9 a 13 h", emergencia: "+56 9 8765 4321" },
  datos: [
    { label: "Calidad", valor: "Socio" },
    { label: "N° de servicio", valor: "485" },
    { label: "Tipo de facturación", valor: "Normal" },
    { label: "Tipo de tarifa", valor: "Residencial" },
    { label: "Diámetro del medidor", valor: '1/2"' },
    { label: "Sector", valor: "LOS AROMOS" },
    { label: "Consumo promedio últimos 3 meses", valor: "9,3 m³" },
    { label: "Próxima lectura (estimada)", valor: "20/11/2026" },
  ],
  historial: {
    titulo: "Tu consumo, últimos 12 meses",
    unidad: "m³",
    puntos: ["nov", "dic", "ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct"]
      .map((etiqueta, i) => ({ etiqueta, valor: [14, 12, 9.5, 7, 6, 0, 5, 8, 11, 12, 9, 18][i] })),
  },
  tarifario: {
    titulo: "Tarifas vigentes",
    filas: [
      { label: 'Cargo fijo, medidor de 1/2"', valor: "$ 3.500" },
      { label: "0 a 15 m³, por m³", valor: "$ 850" },
      { label: "16 a 25 m³, por m³", valor: "$ 1.200" },
      { label: "Más de 25 m³, por m³", valor: "$ 2.000" },
    ],
  },
  bloques: [{
    filas: [
      { label: "Cargo fijo", valor: "$ 3.500" },
      { label: "Cargo variable agua potable", valor: "$ 16.350" },
      { label: "  0 a 15 m³", valor: "$ 12.750", sub: "15 m³ x $ 850" },
      { label: "  15 a 25 m³", valor: "$ 3.600", sub: "3 m³ x $ 1.200" },
      { label: "SUBTOTAL", valor: "$ 19.850", enfasis: true },
      { label: "Subsidio", valor: "- $ 4.400", sub: "13 m³ subsidiados · 50% otorgado" },
    ],
  }],
  notas: ["Pagos recibidos desde la última facturación: $ 12.300 · último pago 12/09/2026"],
  totalAPagar: {
    valor: "$ 23.450",
    filas: [
      { label: "Convenio de pago · cuota 2/6", valor: "$ 3.000" },
      { label: "Saldo anterior", valor: "$ 5.000" },
    ],
  },
  pago: {
    titulo: "Pago por transferencia",
    lineas: [
      "Banco Estado · Cuenta corriente N° 123456789",
      "Comité de Agua Potable Rural Quebrada Imaginaria",
      "RUT 55.555.555-5 · En el mensaje escribe tu N° de servicio: 485",
    ],
  },
};

test("la boleta más cargada de un comité de agua sale en UNA hoja, sin soltar el gráfico ni las tarifas", async () => {
  const r = await render(CARGADA, {
    emisor: { ...BASE.emisor, razonSocial: "Comité de Agua Potable Rural Quebrada Imaginaria", email: "contacto@apr.cl" },
    resolucion: "Res. 80 del 2014",
  });
  assert.equal(r.hojas, 1);
  assert.ok(r.nivel < NIVEL_SEGUNDA_HOJA, `nivel ${r.nivel}`);
  assert.match(r.texto, /Tu consumo, últimos 12 meses/);
  assert.match(r.texto, /Tarifas vigentes/);
  assert.match(r.texto, /Pago por transferencia/);
  assert.match(r.texto, /Timbre Electrónico SII/);
  assert.equal(veces(r.texto, "TOTAL A PAGAR"), 1);
});

