// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// Texto de una respuesta del SII (página cvc_cgi o CAF) a partir de sus BYTES.
//
// El portal de folios del SII responde `charset=ISO-8859-1` (medido el 25-sep-2026:
// of_genera_archivo y of_confirma_folio, en Maullín y Palena), y el CAF que entrega es
// `<?xml version="1.0"?>` sin encoding, también en ISO-8859-1. `Response.text()` y
// `File.text()` decodifican SIEMPRE como UTF-8: el byte de una Ñ (0xD1) no es UTF-8
// válido y queda como U+FFFD.
//
//   · En una página, eso es texto ilegible ("Cabe se�alar…": el 30-sep-2026 así llegó
//     a la bandeja el motivo por el que el SII no autorizaba timbraje).
//   · En un CAF, es un CAF corrupto: el <DA> que el motor copia al timbre ya no es el
//     que firmó el SII, y recién explota al emitir (toLatin1 lanza con U+FFFD). La
//     razón social (<RS>) de una APR puede traer Ñ o tildes.
//
// Se intenta UTF-8 estricto (lo es una respuesta solo ASCII, o un CAF que alguien
// re-guardó en UTF-8) y, si no es UTF-8 válido, se lee como ISO-8859-1: cada byte es un
// carácter. A mano y no con `TextDecoder("iso-8859-1")`, que en el estándar WHATWG es
// windows-1252 y manda los bytes 0x80–0x9F fuera de Latin-1 (toLatin1 no los podría
// volver a escribir). Nunca devuelve U+FFFD ni caracteres sobre 0xFF por esta vía.
// Puro a propósito: lo prueba texto-sii.test.ts.
// ============================================================================

export function textoDelSii(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    let out = "";
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return out;
  }
}

/** Cuerpo de una respuesta del SII como texto, sin pasar por `Response.text()`. */
export async function cuerpoSii(resp: Response): Promise<string> {
  return textoDelSii(new Uint8Array(await resp.arrayBuffer()));
}

/**
 * ¿El texto se puede volver a escribir en ISO-8859-1 tal cual? Falso si trae U+FFFD o
 * cualquier carácter sobre 0xFF: señal de que se leyó con otra codificación.
 */
export function esLatin1(texto: string): boolean {
  for (let i = 0; i < texto.length; i++) {
    if (texto.charCodeAt(i) > 0xff) return false;
  }
  return true;
}
