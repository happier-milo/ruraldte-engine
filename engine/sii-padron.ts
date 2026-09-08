// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Consulta el padrón de contribuyentes autorizados del SII: la casilla de intercambio de un
 * RUT y los tipos de DTE que el portal le muestra autorizados y sin desautorizar.
 *
 * La casilla a la que va el acuse no viene en el mensaje que trajo el DTE: hay que preguntarle
 * al SII, y `consultarPadronSii` lo hace con sesión mTLS —el mismo `openSiiSession` del
 * timbraje—, así que sin `.pfx` no hay consulta. Read-only; da `null` si el RUT no figura,
 * `mailIntercambio` puede venir `null`, y `parsePadronCsvLine` (el CSV del padrón completo,
 * para backfill) siempre deja `tiposAutorizados` vacío: eso solo lo trae la consulta por RUT.
 *
 * @example
 * ```ts
 * import { consultarPadronSii } from "@ruraldte/engine/sii-padron";
 *
 * // Me llegó un DTE de 76543210-K: ¿a qué casilla le mando el acuse?
 * const ficha = await consultarPadronSii({
 *   rut: "76543210-K",
 *   ambiente: 1, // 1 = Palena (producción) · 0 = Maullín (certificación)
 *   pfxBase64, // el certificado del receptor, sacado de la custodia
 *   pfxPassword,
 * });
 * const casilla = ficha?.mailIntercambio; // null si no tiene casilla registrada
 * const emiteFacturas = ficha?.tiposAutorizados.includes(33) ?? false;
 * ```
 *
 * @module
 */
// ============================================================================
// sii-padron.ts — el padrón de contribuyentes autorizados del SII.
// ============================================================================
//
// Responde LA pregunta del intercambio saliente: ¿a qué casilla le mando el acuse
// de un DTE que me enviaron? La respuesta NO está en el correo que lo trajo. La
// 1ª factura entrante real (un proveedor DTE externo, 2026-07-31) llegó con:
//   · remitente de sobre = `…-000000@ses.proveedor.cl` (Return-Path de rebotes)
//   · sin `CorreoEmisor` dentro del DTE
// y su casilla registrada resultó ser `recepcion@dte.proveedor.cl` — una dirección
// que no aparecía en NINGUNA parte del mensaje. Ninguna heurística sobre las
// cabeceras la habría encontrado: hay que preguntarle al SII.
//
// El portal expone dos caminos (descubiertos VIVO contra Palena, 2026-07-31):
//   · POST /cvc_cgi/dte/ce_consulta_e  {RUT_EMP, DV_EMP}  → un contribuyente (HTML)
//   · GET  /cvc_cgi/dte/ce_empresas_dwnld → el padrón COMPLETO en CSV
//     (`RUT;RAZON SOCIAL;NUMERO RESOLUCION;FECHA RESOLUCION;MAIL INTERCAMBIO;URL`,
//      ~1.74M filas / ~150 MB — por eso el runtime usa la consulta por RUT + caché,
//      y el CSV queda para un backfill masivo, no para el camino caliente).
//
// Ambos exigen sesión mTLS con un certificado (el del propio receptor, que ya está
// en custodia) — se reusa `openSiiSession` de sii-folios.ts, el mismo primitivo del
// timbraje. El parseo es PURO y testeable: la red vive solo en `consultarPadronSii`.
// ============================================================================

import { openSiiSession } from "./sii-folios.ts";

/** Ficha de un contribuyente en el padrón del SII. */
export type ContribuyenteSii = {
  rut: string;
  razonSocial: string | null;
  /** La casilla de intercambio registrada ("Mail de contacto"). Puede faltar. */
  mailIntercambio: string | null;
  nroResolucion: string | null;
  fechaResolucion: string | null;
  /** Códigos de DTE que tiene AUTORIZADOS hoy (sin fecha de desautorización). */
  tiposAutorizados: number[];
};

/** Texto de un nodo HTML: sin tags, entidades resueltas, espacios normalizados. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&aacute;/gi, "á").replace(/&eacute;/gi, "é").replace(/&iacute;/gi, "í")
    .replace(/&oacute;/gi, "ó").replace(/&uacute;/gi, "ú").replace(/&ntilde;/gi, "ñ")
    .replace(/&amp;/gi, "&").replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sin acentos y en minúsculas — las etiquetas del SII varían en encoding. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function celdas(fila: string): string[] {
  return [...fila.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => textOf(m[1]));
}

/**
 * PURO: extrae la ficha desde el HTML de `ce_consulta_e`. Devuelve null si la
 * página no trae la tabla de antecedentes (RUT inexistente / no autorizado).
 *
 * Tolerante por diseño: matchea las etiquetas por palabra clave sin acentos (el
 * portal es legacy y mezcla `&oacute;` con bytes latin-1 crudos en el "N°"), y no
 * asume orden ni cantidad de filas.
 */
export function parsePadronConsulta(html: string): ContribuyenteSii | null {
  const filas = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);

  let rut: string | null = null;
  let razonSocial: string | null = null;
  let mailIntercambio: string | null = null;
  let nroResolucion: string | null = null;
  let fechaResolucion: string | null = null;
  const tiposAutorizados: number[] = [];

  for (const fila of filas) {
    const c = celdas(fila);

    // Tabla de antecedentes: pares etiqueta / valor.
    if (c.length === 2) {
      const k = fold(c[0]);
      const v = c[1].trim();
      if (!v) continue;
      if (/^rut\b/.test(k)) rut = v;
      else if (k.includes("razon social")) razonSocial = v;
      else if (k.includes("mail")) mailIntercambio = v.toLowerCase();
      else if (k.includes("fecha") && k.includes("resolucion")) fechaResolucion = v;
      else if (k.includes("resolucion")) nroResolucion = v;
      continue;
    }

    // Tabla de tipos: [código, descripción, autorizado, desautorizado]. Cuenta como
    // vigente solo si tiene fecha de autorización y NO de desautorización.
    if (c.length === 4 && /^\d{2,3}$/.test(c[0])) {
      const autorizado = c[2].trim();
      const desautorizado = c[3].trim();
      if (autorizado && !desautorizado) tiposAutorizados.push(Number(c[0]));
    }
  }

  if (!rut) return null;
  return { rut, razonSocial, mailIntercambio, nroResolucion, fechaResolucion, tiposAutorizados };
}

/** Una línea del CSV del padrón completo (`ce_empresas_dwnld`). */
export function parsePadronCsvLine(linea: string): ContribuyenteSii | null {
  const p = linea.split(";");
  if (p.length < 5) return null;
  const rut = p[0].trim();
  if (!/^\d{1,8}-[\dkK]$/.test(rut)) return null; // salta la cabecera y la basura
  const mail = p[4].trim().toLowerCase();
  return {
    rut,
    razonSocial: p[1].trim() || null,
    mailIntercambio: mail || null,
    nroResolucion: p[2].trim() || null,
    fechaResolucion: p[3].trim() || null,
    tiposAutorizados: [], // el CSV no los trae; solo la consulta por RUT
  };
}

/**
 * Argumentos de `consultarPadronSii`: a quién consultar y con qué certificado abrir la sesión mTLS
 * contra el portal del SII.
 *
 * El `rut` se parte por el guión para armar el POST (`RUT_EMP` / `DV_EMP`), así que uno sin guión
 * lanza — pero recién con la sesión ya abierta, o sea el handshake mTLS igual se gastó. El dígito
 * verificador puede ir en minúscula: se pasa a mayúscula antes de partirlo.
 */
export type PadronQueryArgs = {
  /** RUT a consultar, con guión ("76543210-3"). */
  rut: string;
  /** 0 = certificación (Maullín) · 1 = producción (Palena). */
  ambiente: 0 | 1;
  /** Certificado con el que se abre la sesión (el del receptor, en custodia). */
  pfxBase64: string;
  pfxPassword: string;
};

/**
 * Consulta UN contribuyente en el padrón. Read-only: no muta nada en el SII.
 * Devuelve null si el RUT no figura como autorizado.
 */
export async function consultarPadronSii(args: PadronQueryArgs): Promise<ContribuyenteSii | null> {
  const base = args.ambiente === 1 ? "https://palena.sii.cl" : "https://maullin.sii.cl";
  const formUrl = `${base}/cvc_cgi/dte/ce_consulta_rut`;
  const session = await openSiiSession(
    { pfxBase64: args.pfxBase64, pfxPassword: args.pfxPassword, ambiente: args.ambiente },
    formUrl,
  );
  const [num, dv] = args.rut.trim().toUpperCase().split("-");
  if (!num || !dv) throw new Error(`RUT inválido para el padrón: ${args.rut}`);
  const resp = await session.fetch("padron", `${base}/cvc_cgi/dte/ce_consulta_e`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ RUT_EMP: num, DV_EMP: dv, ACEPTAR: "Consultar" }).toString(),
  });
  return parsePadronConsulta(resp.body);
}
