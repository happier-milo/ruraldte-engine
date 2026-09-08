// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// _pdf-text.mjs — leer el texto REALMENTE DIBUJADO en un PDF.
//
// Verificar el payload de entrada no prueba nada: lo que importa es si el dato
// salió impreso. Este helper infla los content streams y junta los operandos de
// los operadores de texto, así los tests asertan sobre el papel y no sobre la
// intención.
//
// pdf-lib emite `<hex> Tj` (no literales `(...)`) y codifica las StandardFonts
// en WinAnsi — que en el rango que usamos (tildes, ñ, ·, ³) coincide con latin1.
// El em dash NO coincide (WinAnsi 0x97), así que las aserciones lo evitan.
// ============================================================================
import zlib from "node:zlib";

/** Desescapa un literal PDF `(...)`: octales \\ooo + escapes de un carácter. */
function unescapeLiteral(s) {
  return s.replace(/\\(\d{1,3}|[\s\S])/g, (_, g) =>
    /^\d{1,3}$/.test(g)
      ? String.fromCharCode(parseInt(g, 8))
      : ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" })[g] ?? g);
}

/** @param {Uint8Array} bytes @returns {string} todo el texto dibujado, en orden */
export function extractPdfText(bytes) {
  const buf = Buffer.from(bytes);
  const chunks = [];
  for (let i = 0;;) {
    const s = buf.indexOf("stream", i);
    if (s === -1) break;
    let start = s + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const e = buf.indexOf("endstream", start);
    if (e === -1) break;
    const raw = buf.subarray(start, e);
    let data;
    try {
      data = zlib.inflateSync(raw);
    } catch {
      data = raw;
    }
    chunks.push(data.toString("latin1"));
    i = e + 9;
  }
  const body = chunks.join("\n");
  const out = [];
  const re = /(?:<([0-9A-Fa-f\s]*)>|\(((?:\\[\s\S]|[^\\()])*)\))\s*Tj/g;
  for (let m; (m = re.exec(body)) !== null;) {
    if (m[1] != null) {
      const hex = m[1].replace(/\s+/g, "");
      let s = "";
      for (let j = 0; j + 1 < hex.length; j += 2) {
        s += String.fromCharCode(parseInt(hex.slice(j, j + 2), 16));
      }
      out.push(s);
    } else {
      out.push(unescapeLiteral(m[2]));
    }
  }
  return out.join(" ");
}
