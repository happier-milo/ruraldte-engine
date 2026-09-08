// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// sii-text.test.ts — sanitizeSiiText: puntuación Unicode → ISO-8859-1.
// ============================================================================

import { assert, assertEquals } from "jsr:@std/assert@1";
import { sanitizeSiiText } from "./sii-text.ts";

/** Todo char ≤ 0xFF (condición para que toLatin1/encodeLatin1 no tiren). */
function isLatin1(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0xff) return false;
  return true;
}

Deno.test("sanitizeSiiText: el em-dash que mordió en cert (folio 44) → '-' y queda Latin-1", () => {
  const glosa = "Servicio RuralDTE — smoke post-cert NC61"; // — U+2014
  const out = sanitizeSiiText(glosa);
  assertEquals(out, "Servicio RuralDTE - smoke post-cert NC61");
  assert(isLatin1(out), "el resultado debe ser codificable en iso-8859-1");
});

Deno.test("sanitizeSiiText: guiones/comillas/elipsis tipográficas → equivalente Latin-1", () => {
  assertEquals(sanitizeSiiText("a–b—c−d‑e"), "a-b-c-d-e"); // – — − ‑
  assertEquals(sanitizeSiiText("“hola” ‘chao’"), '"hola" \'chao\''); // " " ' '
  assertEquals(sanitizeSiiText("etc…"), "etc..."); // …
  assertEquals(sanitizeSiiText("100€"), "100EUR"); // €
});

Deno.test("sanitizeSiiText: preserva acentos y símbolos que YA son Latin-1 (no los toca)", () => {
  const latin1 = "TECNOLOGÍA áéíóúñü «guillemets» © ® ° · µ ½";
  assertEquals(sanitizeSiiText(latin1), latin1);
  assert(isLatin1(latin1));
});

Deno.test("sanitizeSiiText: idempotente (clave para reimpreso byte-idéntico)", () => {
  const s = "A—B “q” … €";
  assertEquals(sanitizeSiiText(sanitizeSiiText(s)), sanitizeSiiText(s));
});

Deno.test("sanitizeSiiText: NO inventa reemplazo para lo exótico no mapeado (cae al guardián duro)", () => {
  // Un emoji no mapeado se DEJA > 0xFF a propósito: encodeLatin1/toLatin1 debe
  // seguir fallando fuerte (con alerta), no lo silenciamos ni lo convertimos a '?'.
  const emoji = "hola \u{1F600}";
  const out = sanitizeSiiText(emoji);
  assert(out.includes("\u{1F600}"), "no debe descartar silenciosamente el char exótico");
  assert(!isLatin1(out), "sigue no-Latin1 → el guardián duro lo detecta");
});

Deno.test("sanitizeSiiText: fast-path ASCII puro devuelve el mismo string", () => {
  const s = "SERVICIO DE ARRIENDO 2026";
  assertEquals(sanitizeSiiText(s), s);
});
