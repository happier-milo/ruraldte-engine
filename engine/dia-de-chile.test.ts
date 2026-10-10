// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

import { assertEquals } from "jsr:@std/assert@1";
import { chileDay, chileDayOf } from "./dia-de-chile.ts";

// Todos los instantes traen su zona ("…Z"): sin zona se leerían en la de la
// máquina y el test pasaría o fallaría según dónde corra.
const utcDay = (iso: string) => new Date(iso).toISOString().slice(0, 10);

Deno.test("chileDay: a las 23:00 del 3 de octubre (verano, UTC-3) sigue siendo el 3", () => {
  const at = "2026-10-04T02:00:00Z";
  assertEquals(chileDay(new Date(at)), "2026-10-03");
  // Lo que daba el corte en UTC: mañana.
  assertEquals(utcDay(at), "2026-10-04");
});

Deno.test("chileDay: la última noche del mes no cae en el mes siguiente", () => {
  assertEquals(chileDay(new Date("2026-11-01T01:30:00Z")), "2026-10-31");
  assertEquals(chileDay(new Date("2027-01-01T02:59:00Z")), "2026-12-31");
});

Deno.test("chileDay: en invierno (UTC-4) el día cambia a las 04:00 UTC", () => {
  assertEquals(chileDay(new Date("2026-07-01T01:30:00Z")), "2026-06-30");
  assertEquals(chileDay(new Date("2026-07-01T03:59:00Z")), "2026-06-30");
  assertEquals(chileDay(new Date("2026-07-01T04:00:00Z")), "2026-07-01");
});

Deno.test("chileDay: en verano (UTC-3) el día cambia a las 03:00 UTC", () => {
  assertEquals(chileDay(new Date("2026-10-04T02:59:00Z")), "2026-10-03");
  assertEquals(chileDay(new Date("2026-10-04T03:00:00Z")), "2026-10-04");
});

Deno.test("chileDay: de día coincide con UTC", () => {
  const at = "2026-10-03T15:00:00Z";
  assertEquals(chileDay(new Date(at)), utcDay(at));
});

Deno.test("chileDay: un vencimiento a 90 días se fecha con el día de Chile de ese instante", () => {
  // Certificado emitido a las 22:30 del 3 de octubre: vale hasta el 1 de enero.
  const emitido = new Date("2026-10-04T01:30:00Z");
  const hasta = new Date(emitido.getTime() + 90 * 24 * 3600_000);
  assertEquals(chileDay(hasta), "2027-01-01");
  assertEquals(hasta.toISOString().slice(0, 10), "2027-01-02");
});

Deno.test("chileDay: sin argumento da el día de ahora, con forma de fecha", () => {
  assertEquals(/^\d{4}-\d{2}-\d{2}$/.test(chileDay()), true);
  assertEquals(chileDay(), chileDay(new Date()));
});

Deno.test("chileDay: una fecha inválida da vacío, no una excepción", () => {
  assertEquals(chileDay(new Date("no es una fecha")), "");
});

Deno.test("chileDayOf: un instante guardado da su día de Chile, no el de UTC", () => {
  // El caso medido en producción: pago en línea del 14 de agosto a las 22:01
  // (invierno, UTC-4). Como lo entrega un timestamptz y como lo arma el webhook.
  assertEquals(chileDayOf("2026-08-15T02:01:28+00:00"), "2026-08-14");
  assertEquals(chileDayOf("2026-08-15T02:01:28.000Z"), "2026-08-14");
  // Lo que daba el corte de texto: el día siguiente.
  assertEquals("2026-08-15T02:01:28+00:00".slice(0, 10), "2026-08-15");
});

Deno.test("chileDayOf: la última noche del mes y del año no pasan al siguiente", () => {
  assertEquals(chileDayOf("2026-11-01T01:30:00Z"), "2026-10-31");
  assertEquals(chileDayOf("2027-01-01T02:59:00Z"), "2026-12-31");
});

Deno.test("chileDayOf: una fecha sin hora vuelve tal cual (no se corre al día anterior)", () => {
  assertEquals(chileDayOf("2026-08-14"), "2026-08-14");
  assertEquals(chileDayOf(" 2026-08-14 "), "2026-08-14");
  // Lo que pasaría si se leyera como instante: medianoche UTC es el 13 en Chile.
  assertEquals(chileDay(new Date("2026-08-14")), "2026-08-13");
});

Deno.test("chileDayOf: de día coincide con el corte de texto", () => {
  assertEquals(chileDayOf("2026-08-14T15:00:00+00:00"), "2026-08-14");
});

Deno.test("chileDayOf: acepta un Date", () => {
  assertEquals(chileDayOf(new Date("2026-08-15T02:01:28Z")), "2026-08-14");
});

Deno.test("chileDayOf: lo vacío o ilegible da vacío, no una excepción ni una fecha inventada", () => {
  assertEquals(chileDayOf(null), "");
  assertEquals(chileDayOf(undefined), "");
  assertEquals(chileDayOf(""), "");
  assertEquals(chileDayOf("sin-fecha"), "");
  assertEquals(chileDayOf(new Date("no es una fecha")), "");
});
