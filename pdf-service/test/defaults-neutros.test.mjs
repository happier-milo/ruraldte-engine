// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// Los DEFAULTS del render no pueden imprimir NUESTRA marca en el documento de
// un tercero.
// ----------------------------------------------------------------------------
// Este servicio nació dentro de Comunidad Rural y arrastró defaults con su
// nombre. Uno de ellos —`verifyUrl` de boleta, que salía como
// `www.comunidadrural.cl/boleta`— se pudo cambiar recién al verificar que
// NINGÚN llamador dependía de él: los tres que existen (agent-boleta-pdf y
// dte-demo-boleta en CR, y el gateway de RuralDTE) lo pasan explícito.
//
// Y ahí estaba el problema de fondo: cambiarlo NO rompió ningún test. Un valor
// que se imprime en un documento tributario y que nadie asegura puede volver
// mañana sin que se note. Este archivo es esa aseguranza — asertando sobre el
// texto REALMENTE DIBUJADO, no sobre el input.
//
// `plataforma` sigue con su default heredado a propósito (los dos llamadores de
// CR dependen de él para su propio membrete); acá queda anclado para que el día
// que cambie sea una decisión y no un accidente.
// ============================================================================
import test from "node:test";
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
  items: [{ nombre: "Servicio", cantidad: 1, precio: 45600, valor: 45600 }],
  totales: { neto: 38319, iva: 7281, total: 45600 },
  tedXml: TED,
};

const render = async (input) => extractPdfText((await generateBoletaElectronicaPdf(input)).pdf);

/** La URL tal como quedó DIBUJADA en la línea del timbre. */
const urlDeVerificacion = (texto) => texto.match(/Verifique este documento en (\S+)/)?.[1];

test("sin verifyUrl, la boleta remite al SII — no a un dominio nuestro", async () => {
  const url = urlDeVerificacion(await render(BASE));
  assert.equal(url, "www.sii.cl");
  // La aserción va sobre la URL y no sobre la página entera: la línea legal SÍ
  // dice "ComunidadRural" mientras `plataforma` conserve su default heredado,
  // y confundir las dos cosas fue justo lo que hizo fallar la primera versión
  // de este test.
  assert.doesNotMatch(url, /comunidadrural|ruraldte/i);
});

test("con verifyUrl propia manda la del emisor, sin el esquema", async () => {
  const texto = await render({ ...BASE, verifyUrl: "https://boletas.miempresa.cl" });
  assert.match(texto, /Verifique este documento en boletas\.miempresa\.cl/);
  assert.doesNotMatch(texto, /https:\/\//);
});

test("sin plataforma, la línea legal NO nombra a nadie — y sigue siendo gramatical", async () => {
  // El default heredado era "ComunidadRural": el nombre del primer cliente impreso
  // en el documento de cualquiera que no pasara el campo. Se quitó el 08-sep-2026,
  // después de que las dos edge functions de CR que dependían de él lo pasaran
  // explícito y se desplegaran (versiones 58 y 59). Este test lo deja anclado del
  // lado correcto.
  const texto = await render(BASE);
  assert.match(texto, /Documento tributario electrónico emitido por EMISOR SPA\./);
  assert.doesNotMatch(texto, /declarado al SII a trav[eé]s de/);
  assert.doesNotMatch(texto, /ComunidadRural|RuralDTE/);
});

test("con plataforma declarada, la cláusula vuelve completa", async () => {
  assert.match(
    await render({ ...BASE, plataforma: "ComunidadRural" }),
    /declarado al SII a trav[eé]s de ComunidadRural\./,
  );
});

test("con plataforma propia, la línea legal nombra a quien emite", async () => {
  const texto = await render({ ...BASE, plataforma: "MiPlataforma" });
  assert.match(texto, /declarado al SII a trav[eé]s de MiPlataforma/);
  assert.doesNotMatch(texto, /ComunidadRural/);
});
