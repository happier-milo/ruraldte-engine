// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// Tests de las tablas de códigos oficiales (Aduana Anexo 51 + SII formato_dte).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CLAUSULA_VENTA,
  MONEDA_ISO_A_SII,
  MONEDAS_ADUANA,
  monedaSii,
  PAISES,
  paisCodigo,
  PUERTOS,
  puertoCodigo,
  TIPOS_BULTO,
  tipoBultoCodigo,
  UNIDADES_MEDIDA,
  VIA_TRANSPORTE,
} from "./aduana-codes.ts";
import {
  FORMA_PAGO,
  IMPUESTOS_RETENCIONES,
  IND_TRASLADO,
  TIPOS_DTE,
} from "./sii-codigos.ts";

Deno.test("Aduana: completitud vs Anexo 51 (re-sourcing de la fuente oficial)", () => {
  assert(Object.keys(PAISES).length >= 230, `países ${Object.keys(PAISES).length}`);
  assert(Object.keys(PUERTOS).length >= 340, `puertos ${Object.keys(PUERTOS).length}`);
  assert(Object.keys(TIPOS_BULTO).length >= 60, `bultos ${Object.keys(TIPOS_BULTO).length}`); // antes 15 parcial
});

Deno.test("Aduana: cláusulas = códigos OFICIALES (sin los inventados 10/11/12/17/18)", () => {
  assertEquals(CLAUSULA_VENTA[5], "FOB");
  assertEquals(CLAUSULA_VENTA[6], "S/CL");
  assertEquals(CLAUSULA_VENTA[2], "CFR");
  assertEquals(CLAUSULA_VENTA[7], "FCA"); // oficial: FCA = 7 (no 10)
  for (const invalido of [10, 11, 12, 17, 18]) {
    assertEquals(CLAUSULA_VENTA[invalido], undefined, `cláusula ${invalido} no existe en Anexo 51-21`);
  }
});

Deno.test("Aduana: unidad de medida usa sigla oficial (MT3, no MCUB)", () => {
  assertEquals(UNIDADES_MEDIDA[16], "MT3");
  assertEquals(UNIDADES_MEDIDA[6], "KN");
});

Deno.test("Aduana: países/puertos clave + Nacionalidad", () => {
  assertEquals(PAISES[997], "CHILE");
  assert(PAISES[225].startsWith("ESTADOS UNIDOS"));
  assertEquals(PAISES[201], "VENEZUELA");
  assert(PUERTOS[905].includes("VALPARA"));
  assertEquals(PUERTOS[901], "ARICA");
});

Deno.test("Aduana: helpers de mapeo nombre/ISO → código", () => {
  assertEquals(monedaSii("USD"), "DOLAR USA"); // forma certificada (emisión)
  assertEquals(MONEDAS_ADUANA[13], "DÓLAR USA"); // abreviatura oficial (catálogo)
  assertEquals(paisCodigo("VENEZUELA"), 201);
  assert(puertoCodigo("ARICA") === 901);
  assert(tipoBultoCodigo("PALLETS") !== undefined);
  assert(VIA_TRANSPORTE[1] !== undefined);
});

Deno.test("Aduana: sin colisiones de clave (cada código mapea a 1 valor)", () => {
  for (const tabla of [PAISES, PUERTOS, TIPOS_BULTO, CLAUSULA_VENTA, UNIDADES_MEDIDA]) {
    const keys = Object.keys(tabla);
    assertEquals(new Set(keys).size, keys.length);
  }
});

Deno.test("SII: catálogo general (TipoDTE, FmaPago, IndTraslado)", () => {
  assertEquals(TIPOS_DTE[33], "Factura Electrónica");
  assertEquals(TIPOS_DTE[110], "Factura de Exportación Electrónica");
  assertEquals(Object.keys(FORMA_PAGO).length, 3);
  assertEquals(FORMA_PAGO[3], "Sin costo (entrega gratuita)");
  assertEquals(IND_TRASLADO[9], "Venta para exportación");
});

Deno.test("SII: impuestos/retenciones — código 15 (cert) + variantes cambio de sujeto", () => {
  assertEquals(IMPUESTOS_RETENCIONES[15].tipo, "R");
  assertEquals(IMPUESTOS_RETENCIONES[15].tasa, "agregado");
  assertEquals(IMPUESTOS_RETENCIONES[32].cambioSujetoTotal, 321); // ganado
  assertEquals(IMPUESTOS_RETENCIONES[48].cambioSujetoTotal, 481); // frambuesas
  assertEquals(IMPUESTOS_RETENCIONES[27].tipo, "A"); // adicional bebidas
});
