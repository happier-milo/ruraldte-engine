// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

import { assertEquals } from "jsr:@std/assert@1";
import {
  type CafRow,
  evaluateCaf,
  remainingFolios,
  sha256Hex,
  SII_GLOBAL_TABLES,
  SII_PUBLIC_RESOURCES,
} from "./sii-watch.ts";

const NOW = Date.parse("2026-06-09T12:00:00Z");

function caf(over: Partial<CafRow>): CafRow {
  return {
    id: "caf-x",
    community_id: "c1",
    document_type: 39,
    range_start: 1,
    range_end: 100,
    used_count: 0,
    expires_at: null,
    ...over,
  };
}

Deno.test("remainingFolios: rango menos usados", () => {
  assertEquals(remainingFolios(caf({ range_start: 1, range_end: 100, used_count: 5 })), 95);
  assertEquals(remainingFolios(caf({ range_start: 50, range_end: 60, used_count: 11 })), 0);
});

Deno.test("evaluateCaf: CAF sano no alerta", () => {
  const ev = evaluateCaf(caf({ expires_at: "2026-12-31T00:00:00Z", used_count: 0 }), NOW);
  assertEquals(ev.alert, false);
  assertEquals(ev.remaining, 100);
});

Deno.test("evaluateCaf: por vencer (<=30d) alerta", () => {
  const ev = evaluateCaf(caf({ expires_at: "2026-06-25T00:00:00Z" }), NOW);
  assertEquals(ev.alert, true);
  assertEquals(ev.daysToExpiry, 15);
  assertEquals(ev.reasons.some((r) => r.includes("vence en 15d")), true);
});

Deno.test("evaluateCaf: vencido alerta con días negativos", () => {
  const ev = evaluateCaf(caf({ expires_at: "2026-06-01T00:00:00Z" }), NOW);
  assertEquals(ev.alert, true);
  assertEquals(ev.reasons.some((r) => r.includes("VENCIDO")), true);
});

Deno.test("evaluateCaf: pocos folios (<=10) alerta aunque no venza", () => {
  const ev = evaluateCaf(
    caf({ range_start: 1, range_end: 100, used_count: 95, expires_at: "2027-01-01T00:00:00Z" }),
    NOW,
  );
  assertEquals(ev.alert, true);
  assertEquals(ev.remaining, 5);
  assertEquals(ev.reasons.some((r) => r.includes("5 folios")), true);
});

Deno.test("sha256Hex: known-answer vector (\"abc\")", async () => {
  const h = await sha256Hex(new TextEncoder().encode("abc"));
  assertEquals(h, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

Deno.test("sha256Hex: detecta cambio de contenido", async () => {
  const a = await sha256Hex(new TextEncoder().encode("v1"));
  const b = await sha256Hex(new TextEncoder().encode("v2"));
  assertEquals(a === b, false);
});

Deno.test("catálogo: recursos públicos + tablas globales presentes", () => {
  assertEquals(SII_PUBLIC_RESOURCES.length, 6);
  assertEquals(SII_PUBLIC_RESOURCES.some((r) => r.key === "openapi.boleta"), true);
  assertEquals(SII_GLOBAL_TABLES.includes("estado"), true);
  assertEquals(SII_GLOBAL_TABLES.length, 5);
});
