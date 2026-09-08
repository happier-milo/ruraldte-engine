// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Genera el Timbre Electrónico de Documentos (TED) de un DTE: arma el `<DD>`, lo firma
 * RSA-SHA1 con la llave privada del CAF y devuelve el `<TED>` listo para incrustar.
 *
 * Lo emitido y lo firmado son dos formas del mismo `<DD>`: al XML va la forma "pretty"
 * con CRLF entre tags (`buildDd`), pero la FRMT firma la compacta (`compactSiiDd`),
 * porque el SII colapsa el whitespace entre tags antes de verificar — firmar el pretty
 * da un timbre que no valida. La firma es RSA-SHA1 cruda (no XMLDSig) sobre los bytes
 * ISO-8859-1 del DD y lanza si queda un carácter fuera de Latin-1; `RSR` e `IT1` se
 * truncan a 40 y pasan por `sanitizeSiiText`. El `<MNT>` no se redondea: pásale el
 * MISMO número del `<MntTotal>` o el SII repara TED-3-640. No verifica la FRMA del CAF
 * ni que el folio caiga dentro de su `<RNG>`.
 *
 * @example
 * ```ts
 * import {
 *   buildTed,
 *   compactSiiDd,
 *   extractCafPublicKeyPem,
 *   verifySha1Rsa,
 * } from "@ruraldte/engine/ted";
 *
 * const cafXml = await Deno.readTextFile("caf-39.xml"); // el <AUTORIZACION> del SII
 *
 * const { ted, dd, frmt } = buildTed({
 *   cafXml,
 *   rutEmisor: "76543210-K",
 *   tipoDte: 39,
 *   folio: 1,
 *   fechaEmision: "2026-06-08",
 *   rutReceptor: "22222222-2",   // si lo omites queda el genérico "66666666-6"
 *   razonSocialReceptor: "Cliente de prueba",
 *   montoTotal: 29800,           // el MISMO valor que el <MntTotal> del DTE
 *   item1: "Cambio de aceite",
 *   tstedIso: "2026-06-08T13:37:07",
 * });
 *
 * // `ted` se incrusta tal cual en el <Documento>; la FRMT verifica sobre el DD COMPACTO.
 * verifySha1Rsa(compactSiiDd(dd), frmt, extractCafPublicKeyPem(cafXml)); // true
 * ```
 *
 * @module
 */
// ============================================================================
// boleta-ted.ts — Timbre Electrónico (TED) de una boleta DTE 39/41.
// ============================================================================
//
// Plan B (motor propio, ver docs/PLAN_B_DTE_PROPIO.md): el TED es el sello
// anti-falsificación que el SII re-valida. Estructura (estándar chileno, "mismo
// formato de la Factura" — boletas_elec.pdf §F + instructivo DTE):
//
//   <TED version="1.0">
//     <DD>
//       <RE>rut emisor</RE><TD>39|41</TD><F>folio</F><FE>AAAA-MM-DD</FE>
//       <RR>rut receptor</RR><RSR>razón social receptor</RSR>
//       <MNT>monto total</MNT><IT1>nombre 1er ítem</IT1>
//       <CAF version="1.0">…</CAF>            ← bloque CAF público (del AUTORIZACION)
//       <TSTED>AAAA-MM-DDThh:mm:ss</TSTED>
//     </DD>
//     <FRMT algoritmo="SHA1withRSA">…firma del DD con la llave privada del CAF…</FRMT>
//   </TED>
//
// La FRMT NO es XMLDSig: es una firma RSA-SHA1 *cruda* sobre el elemento <DD>.
//
// ⚠️ HALLAZGO CLAVE (ingeniería inversa del oráculo de calibración, aceptado por el SII):
// lo EMITIDO y lo FIRMADO son DOS formas distintas del mismo DD.
//   • EMITIDO (lo que va en el XML): "pretty" con CRLF (`\r\n`) entre cada
//     elemento, sin indentación, expandiendo también el interior del CAF
//     (<RNG>/<RSAPK>). Es byte-idéntico a lo que emite el oráculo de calibración → `buildDd`.
//   • FIRMADO (lo que cubre la FRMT): el DD COMPACTO, sin NINGÚN whitespace entre
//     tags → `compactSiiDd`. El SII canonicaliza (colapsa el whitespace entre
//     tags) ANTES de verificar la FRMT; por eso la firma del oráculo de calibración valida
//     contra el compacto, NO contra el pretty que emite. Verificado: la firma de
//     el oráculo verifica con la RSAPK del CAF sólo sobre la forma compacta.
// Resultado: emitimos pretty (= byte-idéntico al oráculo de calibración) y firmamos compacto
// (= misma FRMT que el oráculo de calibración = lo que valida el SII). Validado sin Maullin.
//
// node-forge@1.3.1 (ya dependencia verificada en el edge runtime Deno).
// ============================================================================

import forge from "npm:node-forge@1.3.1";
import { sanitizeSiiText } from "./sii-text.ts";

/**
 * Campos con que `buildDd` y `buildTed` arman el `<DD>` del timbre: el CAF, la
 * identificación del documento, el receptor, el monto y el primer ítem.
 * `montoTotal` debe ser el MISMO número que el `<MntTotal>` del DTE (el SII repara
 * TED-3-640 si difieren) y `razonSocialReceptor` e `item1` se truncan a 40 caracteres.
 */
export type TedInput = {
  /** CAF XML completo (el <AUTORIZACION> descargado del SII). */
  cafXml: string;
  /** RUT emisor con guión, ej "78416626-0". */
  rutEmisor: string;
  /**
   * Tipo de DTE. El TED (DD: RE/TD/F/FE/RR/RSR/MNT/IT1/CAF/TSTED) es idéntico
   * para toda la familia — boleta 39/41, factura 33/34, NC/ND 56/61, guía 52, FC 46
   * (verificado vs el oráculo F60T33). Por eso se acepta cualquier número.
   */
  tipoDte: number;
  folio: number;
  /** Fecha emisión AAAA-MM-DD. */
  fechaEmision: string;
  /** RUT receptor. Boleta: genérico "66666666-6" si no hay. */
  rutReceptor?: string;
  /** Razón social receptor (máx 40). Boleta puede ir vacío. */
  razonSocialReceptor?: string;
  /**
   * Monto total del DTE. DEBE ser el MISMO valor que el `<Totales><MntTotal>` del
   * documento — el SII repara TED-3-640 ("Monto Total No Corresponde al Timbre") si
   * difieren. CLP estándar (33/34/43/52/56/61, boleta 39/41): entero en pesos.
   * Exportación (110/111/112): DECIMAL en moneda extranjera (hasta 4 dec; el TED
   * <MNT> de <Exportaciones> es xs:decimal fractionDigits=4, no unsignedLong). Por
   * eso el <MNT> del DD NO se redondea: se emite tal cual (`fmtMnt`), idéntico al
   * MntTotal del DTE.
   */
  montoTotal: number;
  /** Nombre del primer ítem (máx 40). */
  item1: string;
  /** Timestamp de generación del timbre, AAAA-MM-DDThh:mm:ss. */
  tstedIso: string;
};

/** Extrae el bloque <CAF version="1.0">…</CAF> del XML de AUTORIZACION. */
export function extractCafBlock(cafXml: string): string {
  const m = cafXml.match(/<CAF\b[\s\S]*?<\/CAF>/);
  if (!m) throw new Error("No se encontró el bloque <CAF> en el XML del CAF");
  return m[0];
}

/** Extrae la llave privada RSA (PEM) del CAF (<RSASK>). */
export function extractCafPrivateKeyPem(cafXml: string): string {
  const m = cafXml.match(/<RSASK>([\s\S]*?)<\/RSASK>/);
  if (!m) throw new Error("No se encontró <RSASK> (llave privada) en el CAF");
  return m[1].trim();
}

/** Extrae la llave pública RSA (PEM) del CAF (<RSAPUBK>) — para verificación. */
export function extractCafPublicKeyPem(cafXml: string): string {
  const m = cafXml.match(/<RSAPUBK>([\s\S]*?)<\/RSAPUBK>/);
  if (!m) throw new Error("No se encontró <RSAPUBK> (llave pública) en el CAF");
  return m[1].trim();
}

function esc(s: string): string {
  return sanitizeSiiText(s) // puntuación Unicode → Latin-1 antes de firmar el DD
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Formatea el `<MNT>` del DD EXACTAMENTE como el `<Totales><MntTotal>` del DTE.
 * El motor (factura-dte.ts) emite el MntTotal con `String(totals.total)`, y el TED
 * recibe ESE MISMO número (`input.totals.total`) → usar también `String(n)` los hace
 * coincidir byte a byte (regla SII: el monto del timbre = el monto del documento;
 * mismatch = reparo TED-3-640). NO redondea:
 *   • CLP entero (estándar/boleta): `String(106231)` = "106231" (idéntico al
 *     comportamiento previo con `Math.round`; un entero no tiene decimal que perder).
 *   • Export decimal: `String(106230.78)` = "106230.78" (antes `Math.round` daba
 *     "106231" → el reparo TED-3-640). El MNT de <Exportaciones> es xs:decimal
 *     fractionDigits=4, así que el decimal es válido y exigido.
 */
export function fmtMnt(n: number): string {
  return String(n);
}

/**
 * Forma COMPACTA del DD: colapsa cualquier whitespace ENTRE tags (`>\s+<` → `><`).
 * Es lo que FIRMA la FRMT y lo que el SII canonicaliza para verificar (y lo que
 * firma el oráculo de calibración). El whitespace DENTRO del texto (ej. "COMUNIDAD RURAL SPA") NO
 * se toca: `>\s+<` sólo matchea cuando entre `>` y `<` hay puro whitespace; el
 * base64 (M/FRMA) no contiene `<`/`>` → intacto.
 */
export function compactSiiDd(dd: string): string {
  return dd.replace(/>\s+</g, "><");
}

/**
 * Forma EMITIDA del DD: "pretty" con CRLF (`\r\n`) entre cada elemento, sin
 * indentación — byte-idéntica a la que emite el oráculo de calibración. Compacta primero
 * (neutraliza el whitespace con que quedó el CAF almacenado: LF, RNG/RSAPK en una
 * sola línea) y luego expande cada frontera de tags (`><` → `>\r\n<`).
 */
export function canonicalizeSiiDd(dd: string): string {
  return compactSiiDd(dd).replace(/></g, ">\r\n<");
}

/** Construye el elemento <DD>…</DD> en el formato EMITIDO (pretty CRLF). La FRMT
 *  NO firma esto sino su forma compacta — ver `buildTed` / `compactSiiDd`. */
export function buildDd(input: TedInput): string {
  const caf = extractCafBlock(input.cafXml);
  const rr = input.rutReceptor ?? "66666666-6";
  const rsr = esc((input.razonSocialReceptor ?? "").slice(0, 40));
  const it1 = esc(input.item1.slice(0, 40));
  // Orden de campos fijo por el esquema DD del SII. Se arma compacto y luego se
  // expande al formato pretty CRLF que emite el oráculo de calibración (la FRMT firma el compacto).
  const compact =
    "<DD>" +
    `<RE>${input.rutEmisor}</RE>` +
    `<TD>${input.tipoDte}</TD>` +
    `<F>${input.folio}</F>` +
    `<FE>${input.fechaEmision}</FE>` +
    `<RR>${rr}</RR>` +
    `<RSR>${rsr}</RSR>` +
    `<MNT>${fmtMnt(input.montoTotal)}</MNT>` +
    `<IT1>${it1}</IT1>` +
    caf +
    `<TSTED>${input.tstedIso}</TSTED>` +
    "</DD>";
  return canonicalizeSiiDd(compact);
}

/**
 * Convierte un string a su representación de bytes ISO-8859-1 (Latin-1) como
 * "binary string" forge (cada char = 1 byte). El SII firma el DD sobre bytes
 * Latin-1, NO UTF-8 (instructivo pág 20 A.2.4: "que las librerías NO realicen
 * transformaciones sobre la codificación, por ejemplo a UTF-8"). Para ASCII es
 * idéntico a UTF-8; con acentos (RSR/IT1) difiere y ESTA es la forma correcta.
 */
function toLatin1(data: string): string {
  let out = "";
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    if (code > 0xff) {
      throw new Error(`signSha1Rsa: carácter fuera de iso-8859-1 en el DD (pos ${i}): U+${code.toString(16)}`);
    }
    out += String.fromCharCode(code);
  }
  return out;
}

/** Firma RSA-SHA1 cruda de un string sobre sus bytes ISO-8859-1 → base64. */
export function signSha1Rsa(data: string, privateKeyPem: string): string {
  const key = forge.pki.privateKeyFromPem(privateKeyPem);
  const md = forge.md.sha1.create();
  md.update(toLatin1(data)); // bytes Latin-1 (sin "utf8"): regla SII
  return forge.util.encode64(key.sign(md));
}

/** Verifica una firma RSA-SHA1 base64 (bytes ISO-8859-1) contra una llave pública PEM. */
export function verifySha1Rsa(data: string, signatureB64: string, publicKeyPem: string): boolean {
  try {
    const key = forge.pki.publicKeyFromPem(publicKeyPem);
    const md = forge.md.sha1.create();
    md.update(toLatin1(data));
    return key.verify(md.digest().bytes(), forge.util.decode64(signatureB64));
  } catch {
    return false;
  }
}

/**
 * Genera el TED completo: el `dd` EMITIDO (pretty CRLF) + la FRMT firmada sobre
 * su forma COMPACTA con la llave privada del CAF. El emisor debe emitir el `dd`
 * byte-idéntico; el SII canonicaliza a compacto para verificar la FRMT (por eso
 * firmamos `compactSiiDd(dd)`, no `dd` — ver el encabezado del módulo).
 */
export function buildTed(input: TedInput): { ted: string; dd: string; frmt: string } {
  const dd = buildDd(input);
  const privateKeyPem = extractCafPrivateKeyPem(input.cafXml);
  const frmt = signSha1Rsa(compactSiiDd(dd), privateKeyPem);
  const ted =
    `<TED version="1.0">` +
    dd +
    `<FRMT algoritmo="SHA1withRSA">${frmt}</FRMT>` +
    `</TED>`;
  return { ted, dd, frmt };
}
