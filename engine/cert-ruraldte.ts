// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Emite el set de pruebas de certificación de boleta completo en UN sobre
 * `<EnvioBOLETA>` firmado y lo manda directo al SII (semilla → token → envío),
 * devolviendo un solo trackId.
 *
 * Cada caso se convierte en una boleta firmada con folio `firstFolio + i`,
 * receptor genérico 66666666-6, `IndServicio` siempre presente (default 3: sin
 * él el SII rechaza por schema) y doble referencia al set (TpoDocRef y CodRef
 * "SET" + RazonRef "CASO-N"), para que el matcher del SII case con cualquiera
 * de las dos. Ojo: esto emite de verdad y quema folios del CAF, y
 * `fchResol`/`nroResol` traen por defecto los de un ejemplo ajeno — pásale los
 * de TU empresa en Maullín. El trackId tampoco es aceptación: hay que consultar
 * el estado aparte, y si el SII no devuelve uno, la función lanza con el cuerpo
 * crudo del rechazo.
 *
 * @example
 * ```ts
 * import { emitCertSetViaRuralDte } from "@ruraldte/engine/cert-ruraldte";
 *
 * const { trackId, sobreDocCount } = await emitCertSetViaRuralDte({
 *   cases: [
 *     { caso: "CASO-1", tipoDocumento: 39, items: [
 *       { nombre: "Cambio de aceite", cantidad: 1, precio: 19900 },
 *       { nombre: "Papel de regalo", cantidad: 17, precio: 120 },
 *     ] },
 *   ],
 *   firstFolio: 6,
 *   fechaEmision: "2026-06-10",
 *   emisor: { rut: "76543210-K", legalName: "AGRICOLA DEMO SPA", giro: "VENTA AL POR MENOR" },
 *   rutEnvia: "22222222-2",
 *   pfxBytes, pfxPassword, cafXml, // desde tu bóveda, nunca hardcodeados
 *   fchResol: "2026-05-02", nroResol: 0, // los de tu empresa en Maullín
 * });
 * console.log(trackId, sobreDocCount);
 * ```
 *
 * @module
 */
// ============================================================================
// cert-ruraldte — emisión del SET de certificación vía el motor PROPIO.
// ============================================================================
//
// PRINCIPIO RECTOR (founder 2026-06-10): RuralDTE es el PRIMARIO para TODO el
// ciclo de boleta — certificación incluida. el oráculo de calibración queda de SECUNDARIO/
// fallback (y como único camino de facturas/NC). Este módulo es el camino
// primario del set:
//
//   N casos del set → buildSignedBoletaDte ×N (multi-ítem, referencia
//   CodRef=SET + RazonRef=CASO-N, IndServicio) → buildEnvioBoleta (UN sobre,
//   un trackId) → authenticate (semilla→token) → sendEnvio directo al SII.
//
// Motivo extra (verificado VIVO 2026-06-10): el dte/generar del oráculo de calibración omite
// IndServicio si no se le pasa y su sobre rebotaba por schema (LSX-00213);
// nuestro motor pasa el schema del SII por construcción.
// ============================================================================

import { type BoletaDteInput, buildSignedBoletaDte } from "./boleta-dte.ts";
import { buildEnvioBoleta } from "./envio-boleta.ts";
import { authenticate, sendEnvio, SII_USER_AGENT, type SiiEnv } from "./sii-client.ts";
import { type CertSetCase, computeBoletaTotals } from "./cert-harness.ts";

/**
 * Parámetros de `emitCertSetViaRuralDte`: los casos del set, el certificado, el CAF y los
 * datos de la carátula del sobre. El orden de `cases` manda —al caso i le toca el folio
 * `firstFolio + i`— y el `precio` de cada línea es unitario, en pesos enteros y bruto (con
 * IVA) salvo en las líneas marcadas `exento`, que se suman tal cual al monto exento.
 */
export type EmitCertSetRuralDteArgs = {
  cases: CertSetCase[];
  /** Primer folio del rango a usar (folio del caso i = firstFolio + i). */
  firstFolio: number;
  /** Fecha de emisión AAAA-MM-DD (= FchInicio de la carátula del RCOF). */
  fechaEmision: string;
  emisor: { rut: string; legalName: string; giro?: string; address?: string; city?: string };
  /** RUT del certificado firmante (persona), ej "22222222-2". */
  rutEnvia: string;
  pfxBytes: Uint8Array;
  pfxPassword: string;
  /** CAF XML (texto) del tipo del set. */
  cafXml: string;
  /** IndServicio (obligatorio en boleta). Set de cert = 3 "venta y servicios". */
  indicadorServicio?: 1 | 2 | 3 | 4;
  /**
   * Fecha/N° de Resolución de la carátula = los datos de LA EMPRESA en el
   * ambiente cert (maullin → "Consultar emisores electrónicos autorizados").
   * El canal legacy rechaza RCT (CRT-3-19) si no calzan; el REST no los valida
   * (engaña). NUNCA copiar el 2014-08-22 de los ejemplos (es del oráculo de calibración).
   */
  fchResol?: string;
  nroResol?: number;
  /** Ambiente SII. El set SIEMPRE corre en "cert" (Maullín). */
  env?: SiiEnv;
  /** Timestamp de firma AAAA-MM-DDTHH:MM:SS (default: ahora). */
  tmstIso?: string;
  fetchFn?: typeof fetch;
};

/**
 * Lo que devuelve `emitCertSetViaRuralDte`: un solo trackId para todo el set, cuántos
 * documentos iban en el sobre y el sobre firmado tal cual se transmitió. Solo lo obtienes
 * si el SII entregó trackId (si no, la función lanza), y ese trackId es acuse de
 * recepción, no aceptación — el estado de cada documento se consulta aparte.
 */
export type EmitCertSetRuralDteResult = {
  trackId: string;
  sobreDocCount: number;
  /** Sobre EnvioBOLETA emitido (string; bytes = encodeLatin1). */
  sobreXml: string;
};

/**
 * Emite el set completo en UN sobre EnvioBOLETA vía el motor propio y lo envía
 * directo al SII. Throwea con el detalle crudo si el SII no devuelve trackId —
 * el caller decide el fallback (el oráculo de calibración).
 */
export async function emitCertSetViaRuralDte(
  args: EmitCertSetRuralDteArgs,
): Promise<EmitCertSetRuralDteResult> {
  if (args.cases.length === 0) throw new Error("emitCertSetViaRuralDte: cases vacío");
  const env: SiiEnv = args.env ?? "cert";
  const iso = args.tmstIso ?? new Date().toISOString().slice(0, 19);
  const indServicio = args.indicadorServicio ?? 3;

  // 1) N DTEs firmados (forma oráculo: Documento pretty + Signature compacta).
  const signedDtes = args.cases.map((setCase, i) => {
    const folio = args.firstFolio + i;
    const totals = computeBoletaTotals(setCase.items);
    const isExenta = setCase.tipoDocumento === 41;
    const input: BoletaDteInput = {
      tipoDte: setCase.tipoDocumento,
      folio,
      fechaEmision: args.fechaEmision,
      indServicio,
      emisor: {
        rut: args.emisor.rut,
        razonSocial: args.emisor.legalName,
        giro: args.emisor.giro ?? "",
        dirOrigen: args.emisor.address ?? "",
        cmnaOrigen: args.emisor.city ?? "",
      },
      // Receptor genérico del set de pruebas (IndServicio 3 lo admite).
      receptor: { rut: "66666666-6", razonSocial: "Set de pruebas SII" },
      items: setCase.items.map((it) => ({
        nombre: it.nombre,
        cantidad: it.cantidad,
        precio: it.precio,
        exento: it.exento || isExenta,
        unidadMedida: it.unidadMedida,
      })),
      totals,
      // Referencia del SET de certificación — CINTURÓN Y TIRANTES (ambos campos):
      // el "Set Prueba BE.txt" oficial instruye `<CodRef> SET` + `<RazonRef> CASO-N`,
      // y la convención de factura usa TpoDocRef="SET" + FolioRef. El Formato
      // Boletas v4.2 §E valida AMBOS: TpoDocRef alfabético = "no hay validación"
      // (admite SET; FolioRef pasa a obligatorio) y CodRef en boleta es código
      // LIBRE de la empresa (no el enum 1/2/3 de factura). Emitimos los dos para
      // que el matcher del set case con cualquiera. (Los SRH previos eran RFR del
      // firmante, no de la referencia — ver manual §3.)
      referencia: {
        tipoDocRef: "SET",
        folioRef: parseInt(setCase.caso.replace(/\D/g, ""), 10) || (i + 1),
        codRef: "SET",
        razonRef: setCase.razonReferencia ?? setCase.caso,
      },
      cafXml: args.cafXml,
      tstedIso: iso,
      tmstFirma: iso,
      documentId: `F${folio}T${setCase.tipoDocumento}`,
    };
    return buildSignedBoletaDte(input, args.pfxBytes, args.pfxPassword);
  });

  // 2) UN sobre con los N DTEs (la certificación valida el set como UN envío).
  const sobre = buildEnvioBoleta({
    setId: `SET_CERT_F${args.firstFolio}`,
    signedDtes,
    caratula: {
      rutEmisor: args.emisor.rut,
      rutEnvia: args.rutEnvia,
      rutReceptor: "60803000-K",
      fchResol: args.fchResol ?? "2014-08-22",
      nroResol: args.nroResol ?? 0,
      tmstFirmaEnv: iso,
    },
    pfxBytes: args.pfxBytes,
    password: args.pfxPassword,
  });

  // 3) semilla→token→envío directo al SII (pangal en cert).
  const token = await authenticate(env, args.pfxBytes, args.pfxPassword, {
    userAgent: SII_USER_AGENT,
    fetchFn: args.fetchFn,
  });
  const sent = await sendEnvio(env, {
    xmlBytes: sobre.bytes,
    token,
    rutSender: args.rutEnvia,
    rutCompany: args.emisor.rut,
    userAgent: SII_USER_AGENT,
    fetchFn: args.fetchFn,
  });
  if (sent.status >= 400 || !sent.trackId) {
    throw new Error(
      `emitCertSetViaRuralDte: envío SII rechazado (HTTP ${sent.status}): ${
        sent.raw.slice(0, 300)
      }`,
    );
  }

  return { trackId: sent.trackId, sobreDocCount: args.cases.length, sobreXml: sobre.xml };
}
