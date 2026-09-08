// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// El membrete de la factura lleva el logo de Comunidad Rural SOLO cuando el
// documento es de CR: los tenants white-label del motor (plataforma ≠
// ComunidadRural, p.ej. RuralDTE) van sin logo de plataforma — ni dibujado ni
// embebido en el PDF. Se cuentan los XObjects de imagen del PDF resultante:
// timbre PDF417 = 1; el logo (PNG con alfa) suma 2 más (imagen + SMask).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { generateFacturaPdf } from "../src/lib/factura-pdf.mjs";

// El PNG del wordmark es una MARCA, y por eso NO viaja al repo público (Apache 2.0
// no licencia marcas, §6). El render ya sabía vivir sin él —`llevaLogoPlataforma()`
// colapsa el bloque hacia arriba— así que el test se adapta al árbol en el que
// corre en vez de exigir un archivo que en público no existe. Lo que se verifica
// es la MISMA regla en ambos: el logo de plataforma aparece solo si hay logo Y el
// documento es de la plataforma.
const HAY_LOGO = existsSync(new URL("../src/assets/logo-wordmark.png", import.meta.url));
const CON_LOGO = HAY_LOGO ? 3 : 1;   // timbre PDF417 = 1; el PNG con alfa suma imagen + SMask

const TED_FAKE = "<TED version=\"1.0\"><DD><RE>77123456-7</RE><TD>33</TD><F>1</F>" +
  "<FE>2026-07-03</FE><MNT>119000</MNT></DD><FRMT algoritmo=\"SHA1withRSA\">x</FRMT></TED>";

const baseInput = (extra = {}) => ({
  tipoDte: 33,
  folio: 1,
  fechaEmision: "2026-07-03",
  emisor: { rut: "77123456-7", razonSocial: "Tenant Tercero Ltda", comuna: "Los Muermos" },
  receptor: { rut: "76543210-K", razonSocial: "Cliente de Prueba SpA" },
  items: [{ nombre: "Servicio", cantidad: 1, precio: 100000 }],
  totales: { neto: 100000, iva: 19000, exento: 0, total: 119000 },
  tedXml: TED_FAKE,
  ...extra,
});

function countImages(pdfBytes) {
  const raw = Buffer.from(pdfBytes).toString("latin1");
  return (raw.match(/\/Subtype\s*\/Image/g) || []).length;
}

test("factura SIN plataforma va sin logo: solo el timbre", async () => {
  // Antes el default "ComunidadRural" hacía que no declarar nada equivaliera a
  // declararse Comunidad Rural, y el logo de una marca ajena terminaba en el
  // documento de quien solo quería un PDF. Hay que declararla para llevarlo.
  const { pdf } = await generateFacturaPdf(baseInput());
  assert.equal(countImages(pdf), 1);
});

test("factura con plataforma ComunidadRural explícita = mismo membrete con logo", async () => {
  const { pdf } = await generateFacturaPdf(baseInput({ plataforma: "ComunidadRural" }));
  assert.equal(countImages(pdf), CON_LOGO);
});

test("sin el PNG de marca el render NO revienta: sale la factura, sin logo", async (t) => {
  if (HAY_LOGO) return t.skip("hay wordmark en este árbol — el caso lo cubre el repo público");
  const { pdf } = await generateFacturaPdf(baseInput());
  assert.equal(countImages(pdf), 1);
  assert.ok(pdf.length > 1000, "el PDF se generó igual");
});

test("factura de tenant (plataforma RuralDTE) va SIN logo: solo el timbre", async () => {
  const { pdf } = await generateFacturaPdf(baseInput({ plataforma: "RuralDTE" }));
  assert.equal(countImages(pdf), 1);
});
