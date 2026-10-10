// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// cd supabase/functions && deno test -A _shared/dte/texto-sii.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { cuerpoSii, esLatin1, textoDelSii } from "./texto-sii.ts";

/** "COMITÉ DE AGUA POTABLE RURAL ÑUBLE" en ISO-8859-1: É = 0xC9, Ñ = 0xD1. */
const LATIN1 = new Uint8Array([
  ...new TextEncoder().encode("COMIT"), 0xc9, ...new TextEncoder().encode(" DE AGUA POTABLE RURAL "),
  0xd1, ...new TextEncoder().encode("UBLE"),
]);
const ESPERADO = "COMITÉ DE AGUA POTABLE RURAL ÑUBLE";

Deno.test("textoDelSii: bytes ISO-8859-1 conservan la Ñ y las tildes", () => {
  assertEquals(textoDelSii(LATIN1), ESPERADO);
  assertEquals(esLatin1(textoDelSii(LATIN1)), true);
});

Deno.test("textoDelSii: UTF-8 válido (o solo ASCII) se lee como UTF-8", () => {
  assertEquals(textoDelSii(new TextEncoder().encode(ESPERADO)), ESPERADO);
  assertEquals(textoDelSii(new TextEncoder().encode("COMUNIDAD RURAL SPA")), "COMUNIDAD RURAL SPA");
});

Deno.test("textoDelSii: los bytes 0x80-0x9F quedan dentro de Latin-1 (no windows-1252)", () => {
  // TextDecoder("iso-8859-1") daría "€" (U+20AC) para 0x80, que no se puede re-escribir.
  const t = textoDelSii(new Uint8Array([0x41, 0x80, 0xd1]));
  assertEquals(t.charCodeAt(1), 0x80);
  assertEquals(esLatin1(t), true);
});

Deno.test("cuerpoSii: lo que Response.text() rompe, esto lo lee bien", async () => {
  // El defecto: Response.text() decodifica UTF-8 y la Ñ queda como U+FFFD.
  const roto = await new Response(LATIN1).text();
  assertEquals(roto.includes("�"), true);
  assertEquals(esLatin1(roto), false);
  // El arreglo.
  assertEquals(await cuerpoSii(new Response(LATIN1)), ESPERADO);
});
