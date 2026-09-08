// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Envuelve N boletas ya firmadas en el sobre `<EnvioBOLETA>` y firma el `SetDTE`
 * con XMLDSig (RSA-SHA1 sobre C14N inclusiva real).
 *
 * Es un wrapper delgado de `buildEnvioSobre` (`@ruraldte/engine/sobre-dte`): el núcleo
 * cripto vive una sola vez allá y acá solo cambian el elemento raíz y el `schemaLocation`
 * (`EnvioBOLETA_v11.xsd`). Cada DTE entra tal cual salvo el prólogo `<?xml?>`, que se le
 * recorta, y su firma per-DTE no se recalcula; el digest del SetDTE sí se computa sobre
 * los bytes que efectivamente se emiten, así al recanonicalizar el sobre se llega al
 * mismo valor. Sube siempre `bytes` (iso-8859-1), nunca `xml` recodificado en UTF-8.
 * Tira error si no le pasas ningún DTE, si `setId` no sirve como `xs:ID`, si un documento
 * no trae `<DTE>` o `<TipoDTE>`, o si alguna línea pasa de 4000 chars (tope SII 4096,
 * CHR-00002). No valida contra el XSD ni exige que los documentos sean 39/41: el
 * `SubTotDTE` agrupa por el `<TipoDTE>` que encuentre.
 *
 * @example
 * ```ts
 * import { buildEnvioBoleta } from "@ruraldte/engine/sobre-boleta";
 *
 * // `signedDte` viene ya firmado de buildSignedBoletaDte (@ruraldte/engine/boleta).
 * const { bytes, setDigest } = buildEnvioBoleta({
 *   setId: "BOLETA_39_1024", // xs:ID: parte con letra o "_", sin ":" ni espacios
 *   signedDtes: [signedDte],
 *   caratula: {
 *     rutEmisor: "76543210-K",
 *     rutEnvia: "22222222-2", // debe ser el del certificado; el motor no lo verifica
 *     rutReceptor: "60803000-K", // SII
 *     fchResol: "2014-08-22",
 *     nroResol: 0, // 0 en certificación
 *     tmstFirmaEnv: "2026-09-08T10:15:00",
 *   },
 *   pfxBytes,
 *   password,
 * });
 * // `bytes` es lo que va al SII; `setDigest` sirve para auditar el envío.
 * ```
 *
 * @module
 */
// ============================================================================
// envio-boleta.ts — sobre <EnvioBOLETA> (SetDTE) de boletas 39/41.
// ============================================================================
//
// Especialización del motor genérico `buildEnvioSobre` (envio-dte.ts): mismo
// armado de carátula + firma XMLDSig del SetDTE con C14N inclusiva real; solo
// cambia el elemento raíz (<EnvioBOLETA>) y el schemaLocation (EnvioBOLETA_v11.xsd).
//
// El núcleo cripto vive UNA sola vez en envio-dte.ts — duplicarlo es peligroso
// (el bug del 505 / C14N enseñó que el firmado del SetDTE es sutil). Este wrapper
// preserva la API histórica (buildEnvioBoleta + tipos) usada por dte-ruraldte-probe
// y RuralDteProvider; su salida es byte-idéntica a la versión previa (cubierto por
// envio-boleta.test.ts: estructura + "firmar-lo-que-serializo" + verificación de
// la firma del SET).
// ============================================================================

import {
  type BuildEnvioSobreInput,
  type BuildEnvioSobreResult,
  buildEnvioSobre,
  type EnvioSobreCaratula,
  type SobreKind,
} from "./envio-dte.ts";

/** Carátula del sobre EnvioBOLETA (alias del tipo genérico). */
export type EnvioBoletaCaratula = EnvioSobreCaratula;

/** Input de buildEnvioBoleta (alias del tipo genérico). */
export type BuildEnvioBoletaInput = BuildEnvioSobreInput;

/** Resultado de buildEnvioBoleta (alias del tipo genérico). */
export type BuildEnvioBoletaResult = BuildEnvioSobreResult;

/** Tipo del sobre EnvioBOLETA (boleta 39/41). */
export const ENVIO_BOLETA_KIND: SobreKind = {
  rootElement: "EnvioBOLETA",
  schemaLocation: "EnvioBOLETA_v11.xsd",
};

/**
 * Arma el sobre <EnvioBOLETA> con N DTE de boleta firmados y lo firma (XMLDSig
 * sobre el SetDTE) con la C14N inclusiva real. Devuelve string + bytes iso-8859-1.
 * Delega en `buildEnvioSobre` (envio-dte.ts) con la raíz EnvioBOLETA.
 */
export function buildEnvioBoleta(input: BuildEnvioBoletaInput): BuildEnvioBoletaResult {
  return buildEnvioSobre(input, ENVIO_BOLETA_KIND);
}
