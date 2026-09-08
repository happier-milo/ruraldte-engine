// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// Regresión: contenido mínimo de la boleta — Manual de Facturación SSR 3ª ed,
// Capítulo 2 (fuente: docs/research/dga-siss/man_facturacion.txt §286-440).
//
// POR QUÉ ESTE TEST EXISTE
// `validate_water_bill(quota_id)` comprueba que el dato EXISTA en la base; el
// manual exige que APAREZCA en la boleta. Esos son dos tramos distintos y hasta
// ahora nadie verificaba el segundo: el RPC podía devolver ok=true con el socio
// recibiendo un PDF incompleto. Este test cierra esa costura leyendo el TEXTO
// REALMENTE DIBUJADO en el PDF, no el payload de entrada.
//
//   node --test test/boleta-siss-cap2.test.mjs
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateBoletaElectronicaPdf } from "../src/lib/boleta-pdf.mjs";
import { extractPdfText } from "./_pdf-text.mjs";

const b64 = "MIIBnTCCAQYCQ" + "AbCd0123+/9z".repeat(13) + "==";
const TED =
  `<TED version="1.0"><DD><RE>78416626-0</RE><TD>41</TD><F>7</F>` +
  `<FE>2026-07-05</FE><RR>12345678-9</RR><RSR>JOSÉ ÑUÑEZ PÉREZ</RSR>` +
  `<MNT>45600</MNT><IT1>Consumo de agua potable</IT1>` +
  `<CAF version="1.0"><DA><RE>78416626-0</RE><RS>APR ÑUBLE</RS>` +
  `<TD>41</TD><RNG><D>1</D><H>50</H></RNG><FA>2026-07-01</FA>` +
  `<RSAPK><M>${b64}</M><E>Aw==</E></RSAPK><IDK>300</IDK></DA>` +
  `<FRMA algoritmo="SHA1withRSA">${b64}</FRMA></CAF>` +
  `<TSTED>2026-07-05T12:00:00</TSTED></DD>` +
  `<FRMT algoritmo="SHA1withRSA">${b64}</FRMT></TED>`;

/** Boleta de agua con TODO el Capítulo 2 poblado. */
const BOLETA_COMPLETA = {
  tipoDte: 41,
  folio: 7,
  fechaEmision: "2026-07-05",
  emisor: {
    rut: "78416626-0",
    razonSocial: "COMITÉ DE AGUA POTABLE RURAL EJEMPLO",
    giro: "Servicio sanitario rural",
    direccion: "Camino Las Rosas s/n",
    comuna: "Chillán",
    region: "Ñuble",
  },
  receptor: {
    rut: "12345678-9",
    nombre: "JOSÉ ÑUÑEZ PÉREZ",
    direccion: "Parcela 17, Sector El Roble",
    esSocio: true,
  },
  periodo: "Junio 2026",
  medidor: "A-042",
  lectura: {
    anterior: 650,
    actual: 700,
    consumo: 50,
    tarifa: 620,
    unidad: "m³",
    fechaAnterior: "2026-05-25", // §2.f
    fechaActual: "2026-06-25", // §2.f
    unidadesAbonar: 8, // §2.f
  },
  // El perfil SISS (servicios sanitarios) lo arma el emisor y llega ya hecho.
  // Acá va literal para que el test cubra el RENDER; que el perfil produzca
  // esto se prueba del otro lado.
  representacion: {
    datos: [
      { label: "N° de servicio", valor: "SRV-0917" }, // §2.c
      { label: "Tipo de facturación", valor: "Término medio" }, // §2.e
    ],
    bloques: [{ // §2.g
      filas: [
        { label: "Cargo fijo", valor: "$ 4.000" },
        { label: "Cargo variable agua potable", valor: "$ 31.000" },
        { label: "Cargo variable saneamiento", valor: "$ 2.500" },
        { label: "Fondo de reposición y reinversión", valor: "$ 5.000" },
        { label: "SUBTOTAL", valor: "$ 42.500", enfasis: true },
        { label: "Corte y reposición del servicio", valor: "$ 3.200" },
        { label: "Subsidio", valor: "- $ 6.800", sub: "15 m³ subsidiados · 40% otorgado" },
        { label: "Intereses", valor: "$ 1.200" },
        { label: "Reparación por daño del medidor", valor: "$ 2.500" },
        { label: "Convenio de pago — cuota 10/15" },
        { label: "Saldo anterior", valor: "$ 5.600" },
      ],
    }],
    contacto: { fono: "+56 9 5939 4124", horario: "Lunes a viernes de 9:00 a 18:00" }, // §2.i
    notas: ["Pagos recibidos desde la última facturación: $ 38.000 · último pago 12/06/2026"], // §2.h
  },
  items: [
    { nombre: "Cargo fijo mensual", cantidad: 1, precio: 4000 },
    { nombre: "Consumo de agua potable", cantidad: 50, precio: 620, valor: 31000 },
  ],
  totales: { exento: 45600, total: 45600 },
  vencimiento: "2026-08-25",
  tedXml: TED,
};

/**
 * Checklist del §2. Cada entrada falla sola e indica la letra del manual, para
 * que una regresión diga QUÉ obligación normativa se rompió.
 */
const CAP2 = [
  ["§2.a — nombre del usuario", ["JOSÉ ÑUÑEZ PÉREZ"]],
  ["§2.b — domicilio que recibe el servicio", ["Parcela 17, Sector El Roble"]],
  ["§2.c — número de servicio", ["N° de servicio", "SRV-0917"]],
  ["§2.d — identificación del medidor", ["A-042"]],
  ["§2.e — tipo de facturación", ["Tipo de facturación", "Término medio"]],
  ["§2.f — lecturas con sus fechas", ["Lectura anterior", "25/05/2026", "Lectura actual", "25/06/2026"]],
  ["§2.f — m³ a abonar en futuras facturaciones", ["8 m³ a abonar en futuras facturaciones."]],
  ["§2.g — cargo fijo", ["Cargo fijo"]],
  ["§2.g — cargo variable agua potable", ["Cargo variable agua potable"]],
  ["§2.g — cargo variable saneamiento", ["Cargo variable saneamiento"]],
  ["§2.g — fondo de reposición y reinversión", ["Fondo de reposición y reinversión"]],
  ["§2.g — subtotal", ["SUBTOTAL", "$ 42.500"]],
  ["§2.g — corte y reposición", ["Corte y reposición del servicio", "$ 3.200"]],
  ["§2.g — subsidio con signo negativo", ["Subsidio", "- $ 6.800"]],
  ["§2.g — m³ subsidiados y % otorgado", ["15 m³ subsidiados", "40% otorgado"]],
  ["§2.g — intereses", ["Intereses", "$ 1.200"]],
  ["§2.g — otros conceptos", ["Reparación por daño del medidor"]],
  ["§2.g — convenio de pago cuota N/M", ["cuota 10/15"]],
  ["§2.g — saldo anterior", ["Saldo anterior", "$ 5.600"]],
  ["§2.g — total a pagar", ["TOTAL A PAGAR", "$ 45.600"]],
  ["§2.h — pagos desde la última facturación", ["Pagos recibidos desde la última facturación", "$ 38.000", "último pago 12/06/2026"]],
  ["§2.i — fecha de emisión", ["Fecha emisión", "05/07/2026"]],
  ["§2.i — fecha de vencimiento", ["25/08/2026"]],
  ["§2.i — teléfono de atención y emergencias", ["+56 9 5939 4124"]],
  ["§2.i — horario de atención", ["Lunes a viernes de 9:00 a 18:00"]],
];

test("Cap. 2 completo: cada campo obligatorio queda IMPRESO en el PDF", async (t) => {
  const { pdf } = await generateBoletaElectronicaPdf(BOLETA_COMPLETA);
  const texto = extractPdfText(pdf);
  assert.ok(texto.length > 200, "se pudo extraer texto del PDF");

  for (const [obligacion, fragmentos] of CAP2) {
    await t.test(obligacion, () => {
      for (const f of fragmentos) {
        assert.ok(
          texto.includes(f),
          `falta en el PDF renderizado: ${JSON.stringify(f)} (${obligacion})`,
        );
      }
    });
  }
});

test("§2.i — cut_in_progress REEMPLAZA la fecha de vencimiento", async () => {
  const { pdf } = await generateBoletaElectronicaPdf({
    ...BOLETA_COMPLETA,
    representacion: { ...BOLETA_COMPLETA.representacion, leyendaVencimiento: "Corte en trámite" },
  });
  const texto = extractPdfText(pdf);
  assert.ok(texto.includes("Corte en trámite"), "se imprime la leyenda del manual");
  assert.ok(
    !texto.includes("Vence: "),
    "la leyenda reemplaza el vencimiento, no lo acompaña",
  );
  assert.ok(!texto.includes("25/08/2026"), "la fecha de vencimiento no se dibuja");
});

test("§2.i — la franja de corte se dibuja aunque no haya fecha de vencimiento", async () => {
  const sinVenc = {
    ...BOLETA_COMPLETA,
    representacion: { ...BOLETA_COMPLETA.representacion, leyendaVencimiento: "Corte en trámite" },
  };
  delete sinVenc.vencimiento;
  const { pdf } = await generateBoletaElectronicaPdf(sinVenc);
  assert.ok(extractPdfText(pdf).includes("Corte en trámite"));
});

test("rótulo del receptor: socio / no socio / neutro sin el dato", async () => {
  const rotulo = async (esSocio) => {
    const input = { ...BOLETA_COMPLETA, receptor: { ...BOLETA_COMPLETA.receptor } };
    if (esSocio === undefined) delete input.receptor.esSocio;
    else input.receptor.esSocio = esSocio;
    return extractPdfText((await generateBoletaElectronicaPdf(input)).pdf);
  };

  assert.ok((await rotulo(true)).includes("RECEPTOR (SOCIO)"), "socio → (SOCIO)");
  assert.ok((await rotulo(false)).includes("RECEPTOR (NO SOCIO)"), "no socio → (NO SOCIO)");

  // Sin el dato NO se afirma nada: la boleta 39 puede ser de un no socio, pero
  // la de LUZ de un socio también es 39 — inferir del tipoDte etiquetaría mal.
  const neutro = await rotulo(undefined);
  assert.ok(neutro.includes("RECEPTOR"), "queda el rótulo genérico");
  assert.ok(!neutro.includes("RECEPTOR (SOCIO)"), "no afirma que es socio");
  assert.ok(!neutro.includes("RECEPTOR (NO SOCIO)"), "tampoco que no lo es");
});

test("sin `representacion` la boleta mantiene el bloque simple de totales (no regresiona)", async () => {
  const simple = { ...BOLETA_COMPLETA };
  delete simple.representacion;
  const texto = extractPdfText((await generateBoletaElectronicaPdf(simple)).pdf);
  assert.ok(texto.includes("TOTAL A PAGAR"), "cierra en el total");
  assert.ok(texto.includes("Monto exento"), "boleta 41 muestra el monto exento");
  assert.ok(!texto.includes("SUBTOTAL"), "sin bloques no se inventa un subtotal");
  assert.ok(!texto.includes("N° de servicio"), "sin datos extra la tarjeta queda como estaba");
});

// El render es NEUTRO al rubro: no sabe qué es un subsidio. Lo único que hace
// es dibujar las filas que le pasan — quien decide qué conceptos aparecen es el
// emisor (para SISS, del lado del emisor).
test("el render dibuja SOLO las filas recibidas, sin inventar conceptos", async () => {
  const { pdf } = await generateBoletaElectronicaPdf({
    ...BOLETA_COMPLETA,
    representacion: {
      bloques: [{
        filas: [
          { label: "Cargo fijo", valor: "$ 4.000" },
          { label: "SUBTOTAL", valor: "$ 35.000", enfasis: true },
        ],
      }],
    },
  });
  const texto = extractPdfText(pdf);
  assert.ok(texto.includes("Cargo fijo"), "dibuja lo recibido");
  assert.ok(texto.includes("SUBTOTAL"), "respeta el énfasis");
  assert.ok(!texto.includes("Cargo variable saneamiento"), "no agrega filas que nadie pidió");
  assert.ok(!texto.includes("Subsidio"), "no agrega filas que nadie pidió");
});

// Prueba de que el canal sirve a cualquier rubro, no solo a un APR: la misma
// boleta con vocabulario de gimnasio debe salir igual de bien.
test("el mismo canal sirve a otro rubro (no hay vocabulario sanitario en el render)", async () => {
  const gimnasio = { ...BOLETA_COMPLETA };
  delete gimnasio.lectura;
  gimnasio.representacion = {
    datos: [{ label: "Plan", valor: "Oro anual" }],
    bloques: [{
      titulo: "DETALLE DEL PLAN",
      filas: [
        { label: "Mensualidad", valor: "$ 45.000" },
        { label: "Descuento socio antiguo", valor: "- $ 4.500", sub: "10% por 3 años de antigüedad" },
        { label: "TOTAL DEL PLAN", valor: "$ 40.500", enfasis: true },
      ],
    }],
    contacto: { fono: "+56 2 2345 6789", horario: "Todos los días de 7:00 a 22:00" },
    notas: ["Clases grupales restantes este mes: 8"],
  };
  const texto = extractPdfText((await generateBoletaElectronicaPdf(gimnasio)).pdf);
  for (const f of ["Oro anual", "Mensualidad", "Descuento socio antiguo", "- $ 4.500", "DETALLE DEL PLAN", "Clases grupales restantes este mes: 8"]) {
    assert.ok(texto.includes(f), `falta ${JSON.stringify(f)}`);
  }
});
