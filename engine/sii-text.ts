// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Translitera la puntuación tipográfica que no cabe en ISO-8859-1 —guiones largos,
 * comillas curvas, elipsis, viñetas, €, ™, BOM y espacios de ancho cero— a texto que
 * sí es representable en Latin-1, el encoding que el SII exige para el DTE.
 *
 * Un solo carácter sobre 0xFF revienta la firma del TED (`signSha1Rsa`, ./ted) y la
 * serialización del sobre (`encodeLatin1`, ./firma), y el documento queda varado con
 * el folio ya consumido; el culpable casi siempre es texto pegado desde Word. La
 * conversión es determinista e idempotente —condición para que un reimpreso re-arme
 * el TED byte a byte igual—, no toca nada ≤ 0xFF (á, é, ñ, ü y hasta « » ya son
 * Latin-1) y nunca lanza: lo no mapeado, como un emoji, sale tal cual y muere en esos
 * guardianes, que fallan fuerte en vez de silenciar material tributario. Ojo con los
 * reemplazos que no son 1:1 (… → "...", € → "EUR", ™ → "(TM)"): alargan el string.
 * Los constructores de factura, boleta y TED ya lo aplican en su escape XML, así que
 * rara vez lo llamas a mano.
 *
 * @example
 * ```ts
 * import { sanitizeSiiText } from "@ruraldte/engine/sii-text";
 *
 * // Glosa pegada desde un editor rico: comillas curvas, guión largo y elipsis.
 * sanitizeSiiText('Servicio “premium” — plan anual…');
 * // → 'Servicio "premium" - plan anual...'
 *
 * sanitizeSiiText("TECNOLOGÍA ñandú «S.A.»"); // intacto: ya es Latin-1
 * sanitizeSiiText("hola 😀"); // el emoji sale igual → lo caza el guardián de firma
 * ```
 *
 * @module
 */
// ============================================================================
// sii-text.ts — Normalización de texto libre a ISO-8859-1 (Latin-1) para el DTE.
// ----------------------------------------------------------------------------
// El SII EXIGE que el DTE (cuerpo + TED) vaya en iso-8859-1 (instructivo A.2.4).
// Un carácter fuera de Latin-1 revienta la firma del TED (`toLatin1`, boleta-ted)
// Y la serialización del sobre (`encodeLatin1`, xml-signature) → el documento
// queda `manual_pending` con folio consumido. La causa REAL casi siempre es
// puntuación tipográfica que entra por copy-paste de editores ricos / Word:
// guión largo (— U+2014), comillas curvas (' ' " "), elipsis (…), etc.
//
// `sanitizeSiiText` translitera ESE set conocido a su equivalente Latin-1, de
// forma DETERMINISTA e IDEMPOTENTE (clave para que el reimpreso re-arme el TED
// byte-idéntico). NO toca nada ≤ 0xFF (los acentos á/é/í/ñ/ü son Latin-1 válidos
// y DEBEN preservarse) y NO inventa reemplazos para lo exótico no mapeado: eso
// sigue cayendo en el guardián duro (toLatin1/encodeLatin1), que falla fuerte con
// alerta — no silenciamos material tributario, sólo saneamos lo tipográfico.
//
// Mordió el 2026-07-03 en cert (factura 33 folio 44): glosa
// "Servicio RuralDTE — smoke post-cert NC61" → U+2014 en el DD (pos 157).
// ============================================================================

// Puntuación Unicode común (fuera de Latin-1) → equivalente ISO-8859-1.
// Sólo entradas con code point > 0xFF: las « » (0xAB/0xBB), © (0xA9), ® (0xAE),
// ° (0xB0), NBSP (0xA0), etc. YA son Latin-1 y pasan sin tocarse.
const TRANSLITERATE: ReadonlyMap<number, string> = new Map([
  // Guiones / rayas → "-"
  [0x2010, "-"], // ‐ hyphen
  [0x2011, "-"], // ‑ non-breaking hyphen
  [0x2012, "-"], // ‒ figure dash
  [0x2013, "-"], // – en dash
  [0x2014, "-"], // — em dash   ← el que mordió
  [0x2015, "-"], // ― horizontal bar
  [0x2212, "-"], // − minus sign
  // Comillas simples / apóstrofos → "'"
  [0x2018, "'"], // ' left single quote
  [0x2019, "'"], // ' right single quote / apóstrofo tipográfico
  [0x201a, "'"], // ‚ single low-9 quote
  [0x201b, "'"], // ‛ single high-reversed-9 quote
  [0x2032, "'"], // ′ prime
  [0x02b9, "'"], // ʹ modifier prime
  [0x02bc, "'"], // ʼ modifier apostrophe
  // Comillas dobles → '"'
  [0x201c, '"'], // " left double quote
  [0x201d, '"'], // " right double quote
  [0x201e, '"'], // „ double low-9 quote
  [0x201f, '"'], // ‟ double high-reversed-9 quote
  [0x2033, '"'], // ″ double prime
  // Guillemets simples → "'" (los dobles « » ya son Latin-1)
  [0x2039, "'"], // ‹ single left guillemet
  [0x203a, "'"], // › single right guillemet
  // Otros signos frecuentes
  [0x2026, "..."], // … elipsis
  [0x2022, "-"], //   • viñeta
  [0x00b7, "·"], // · middle dot (0xB7, ya Latin-1 — no-op explícito por claridad)
  [0x20ac, "EUR"], // € euro (NO existe en iso-8859-1, sí en 8859-15/cp1252)
  [0x2122, "(TM)"], // ™ trademark
  [0x2028, " "], // line separator
  [0x2029, " "], // paragraph separator
  [0xfeff, ""], // ﻿ BOM / zero-width no-break space → fuera
  [0x200b, ""], // ​ zero-width space → fuera
]);

/**
 * Translitera puntuación tipográfica Unicode a su equivalente ISO-8859-1. Deja
 * intacto todo lo ≤ 0xFF (acentos Latin-1) y todo code point no mapeado (que si
 * es > 0xFF caerá en el guardián duro de firma/serialización). Idempotente.
 */
export function sanitizeSiiText(s: string): string {
  // Fast-path: si no hay ningún char > 0xFF, no hay nada que transliterar.
  let needs = false;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xff) {
      needs = true;
      break;
    }
  }
  if (!needs) return s;

  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0xff) {
      out += ch;
      continue;
    }
    const repl = TRANSLITERATE.get(cp);
    out += repl !== undefined ? repl : ch; // no mapeado > 0xFF → lo deja (guardián duro).
  }
  return out;
}
