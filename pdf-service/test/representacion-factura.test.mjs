// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// El canal `representacion` en el render de FACTURA (33/34/43/46/52/56/61 y
// exportación 110/111/112).
//
// POR QUÉ ESTE TEST EXISTE
// El canal nació boleta-only y `buildHermesRequest` NO se lo mandaba a factura
// a propósito: mandarlo lo habría descartado en silencio, y un emisor creyendo
// que su texto salió impreso es peor que no ofrecer el canal. Ahora el render
// sí lo dibuja, así que lo que hay que fijar es justamente eso — que salga
// IMPRESO, no que llegue al input.
//
//   node --test test/representacion-factura.test.mjs
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateFacturaPdf } from "../src/lib/factura-pdf.mjs";
import { extractPdfText } from "./_pdf-text.mjs";

const b64 = "MIIBnTCCAQYCQ" + "AbCd0123+/9z".repeat(13) + "==";
const TED = `<TED version="1.0"><DD><RE>78416626-0</RE><TD>33</TD><F>101</F>` +
  `<FE>2026-07-24</FE><RR>76543210-K</RR><RSR>DISTRIBUIDORA DEL SUR SPA</RSR>` +
  `<MNT>119000</MNT><IT1>Servicio mensual</IT1>` +
  `<CAF version="1.0"><DA><RE>78416626-0</RE><RS>RURALDTE SPA</RS>` +
  `<TD>33</TD><RNG><D>1</D><H>50</H></RNG><FA>2026-07-01</FA>` +
  `<RSAPK><M>${b64}</M><E>Aw==</E></RSAPK><IDK>300</IDK></DA>` +
  `<FRMA algoritmo="SHA1withRSA">${b64}</FRMA></CAF>` +
  `<TSTED>2026-07-24T12:00:00</TSTED></DD>` +
  `<FRMT algoritmo="SHA1withRSA">${b64}</FRMT></TED>`;

const BASE = {
  tipoDte: 33,
  folio: 101,
  fechaEmision: "2026-07-24",
  emisor: {
    rut: "78416626-0",
    razonSocial: "RURALDTE SPA",
    giro: "Servicios informáticos",
    direccion: "Camino Las Rosas s/n",
    comuna: "Chillán",
  },
  receptor: {
    rut: "76543210-K",
    razonSocial: "DISTRIBUIDORA DEL SUR SPA",
    giro: "Comercio al por mayor",
    direccion: "Av. Argentina 1450",
    comuna: "Chillán",
  },
  items: [{ nombre: "Servicio mensual", cantidad: 1, precio: 100000, valor: 100000 }],
  totales: { neto: 100000, iva: 19000, total: 119000 },
  tedXml: TED,
};

/**
 * Perfil genérico A PROPÓSITO: el render no puede tener vocabulario de ningún
 * rubro. Si esto se dibuja, el mismo canal le sirve a un APR, a un gimnasio o a
 * un arriendo — que es la razón de que el contrato reciba strings ya formateados.
 */
const REP = {
  datos: [
    { label: "N° de contrato", valor: "CT-2026-0917" },
    { label: "Centro de costo", valor: "Operaciones" },
  ],
  bloques: [{
    titulo: "Detalle del cobro",
    filas: [
      { label: "Cargo fijo mensual", valor: "$ 40.000" },
      { label: "Consumo variable sobre lo pactado", valor: "$ 65.000" },
      { label: "SUBTOTAL", valor: "$ 105.000", enfasis: true },
      { label: "Descuento por pago anticipado", valor: "- $ 5.000", sub: "5% sobre el cargo fijo" },
      { label: "Convenio de pago · cuota 3/12" },
    ],
  }],
  contacto: { fono: "+56 9 5939 4124", horario: "Lunes a viernes de 9:00 a 18:00" },
  leyendaVencimiento: "Pago contra entrega",
  notas: ["Pagos recibidos desde la última facturación: $ 38.000"],
};

const render = async (input) => extractPdfText((await generateFacturaPdf(input)).pdf);

test("factura: las cinco superficies del canal salen IMPRESAS", async (t) => {
  const texto = await render({ ...BASE, representacion: REP });
  const casos = [
    ["datos → n° de contrato", "N° de contrato"],
    ["datos → su valor", "CT-2026-0917"],
    ["datos → segunda fila", "Centro de costo"],
    ["bloques → título", "Detalle del cobro"],
    ["bloques → fila simple", "Cargo fijo mensual"],
    ["bloques → fila con énfasis", "SUBTOTAL"],
    ["bloques → subtexto de la fila", "5% sobre el cargo fijo"],
    ["bloques → fila sin monto (solo leyenda)", "Convenio de pago"],
    ["contacto → fono", "5939 4124"],
    ["contacto → horario", "Lunes a viernes"],
    ["leyendaVencimiento", "Pago contra entrega"],
    ["notas", "Pagos recibidos desde"],
  ];
  for (const [nombre, esperado] of casos) {
    await t.test(nombre, () => {
      assert.ok(texto.includes(esperado), `no quedó impreso: ${JSON.stringify(esperado)}`);
    });
  }
});

test("factura: los montos del DTE siguen intactos con el canal encima", async () => {
  // La representación NO altera el documento tributario: es contenido impreso.
  const texto = await render({ ...BASE, representacion: REP });
  assert.ok(texto.includes("Monto Neto"));
  assert.ok(texto.includes("Monto Total"));
  assert.ok(texto.includes("100.000"), "el neto del DTE debe seguir impreso");
  assert.ok(texto.includes("119.000"), "el total del DTE debe seguir impreso");
});

test("factura: sin `representacion` nada cambia (no regresiona)", async () => {
  const texto = await render(BASE);
  assert.ok(texto.includes("Monto Total"));
  assert.ok(!texto.includes("Detalle del cobro"));
  assert.ok(!texto.includes("Convenio de pago"));
  // El control que distingue "se dibujó" de "ya estaba".
  assert.ok(!texto.includes("CT-2026-0917"));
});

test("factura: el render dibuja SOLO las filas recibidas, sin inventar conceptos", async () => {
  const texto = await render({
    ...BASE,
    representacion: { bloques: [{ filas: [{ label: "Arriendo de cancha", valor: "$ 12.000" }] }] },
  });
  assert.ok(texto.includes("Arriendo de cancha"));
  // Nada de vocabulario sanitario ni de ningún otro rubro se cuela por defecto.
  assert.ok(!texto.includes("Subsidio"));
  assert.ok(!texto.includes("Cargo fijo"));
});

test("el canal vale para TODOS los tipos que dibuja este render", async (t) => {
  // Guía, NC/ND, liquidación, factura de compra y exportación comparten el
  // render: si alguno se rompe, se rompe acá y no en producción.
  const porTipo = {
    34: { totales: { exento: 100000, total: 100000 } },
    43: { totales: { neto: 100000, iva: 19000, total: 119000 } },
    46: { totales: { neto: 100000, iva: 19000, total: 119000 } },
    52: { totales: { neto: 100000, iva: 19000, total: 119000 }, despacho: { tipoTraslado: 1 } },
    56: { totales: { neto: 100000, iva: 19000, total: 119000 } },
    61: { totales: { neto: 100000, iva: 19000, total: 119000 } },
    110: { totales: { exento: 1200, total: 1200, tpoMoneda: "USD" } },
    111: { totales: { exento: 1200, total: 1200, tpoMoneda: "USD" } },
    112: { totales: { exento: 1200, total: 1200, tpoMoneda: "USD" } },
  };
  for (const [tipo, extra] of Object.entries(porTipo)) {
    await t.test(`tipo ${tipo}`, async () => {
      const texto = await render({ ...BASE, ...extra, tipoDte: Number(tipo), representacion: REP });
      assert.ok(texto.includes("Detalle del cobro"), "perdió el título del bloque");
      assert.ok(texto.includes("SUBTOTAL"), "perdió la fila con énfasis");
      assert.ok(texto.includes("N° de contrato"), "perdió los datos extra");
      assert.ok(texto.includes("Pagos recibidos desde"), "perdió las notas");
    });
  }
});

test("factura: una etiqueta larguísima se achica o se corta, pero no desborda", async () => {
  const largo = "Concepto con un nombre desmedidamente largo que jamás cabría";
  const texto = await render({
    ...BASE,
    representacion: { bloques: [{ filas: [{ label: largo, valor: "$ 1.000" }] }] },
  });
  // Entra achicada o cortada con "…", pero el principio SIEMPRE se lee.
  assert.ok(texto.includes("Concepto con un nombre"), "la etiqueta larga desapareció del PDF");
});
