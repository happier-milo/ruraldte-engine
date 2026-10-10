// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Firma RSA-SHA1 (PKCS#1 v1.5) de un texto con la clave privada del certificado, usando
 * la implementación nativa del runtime en vez de la de node-forge.
 *
 * La firma no cambia: PKCS#1 v1.5 es determinista, así que la nativa y la de forge dan
 * los mismos bytes para la misma clave y el mismo texto. Lo que cambia es el costo. Medido
 * el 9-oct-2026 con una clave de 2048 bits: 19,6 ms de CPU por firma en forge (JavaScript
 * puro) contra 1,7 ms en `node:crypto`. Esa firma era 20 de los 23 ms que cuesta firmar una
 * boleta, y una edge function tiene 2 segundos de CPU por request.
 *
 * No se confía en que sean iguales: se comprueba. La primera firma con cada clave se
 * calcula de las dos maneras y se comparan; si coinciden, las siguientes van por la
 * nativa. Si no coinciden, o la nativa falla (un runtime que no trae RSA-SHA1), esa clave
 * firma con forge de ahí en adelante y `estadoFirmaNativa()` dice por qué. Nunca sale una
 * firma que forge no habría dado.
 *
 * @example
 * ```ts
 * import { firmarRsaSha1 } from "@ruraldte/engine/rsa-firma";
 *
 * // `signedInfoCanonico` es la forma C14N del <SignedInfo>; `pkeyPem` sale del .pfx.
 * const signatureValue = firmarRsaSha1(pkeyPem, signedInfoCanonico); // base64
 * ```
 *
 * @module
 */
import forge from "npm:node-forge@1.3.1";
import { createSign } from "node:crypto";

/** Firma de bajo nivel: texto (se firma su UTF-8) y clave en PEM → firma en base64. */
export type FirmaRsaSha1 = (pkeyPem: string, textoUtf8: string) => string;

/** La de node-forge: la referencia contra la que se comprueba la nativa, y el respaldo. */
export const firmarConForge: FirmaRsaSha1 = (pkeyPem, textoUtf8) => {
  const md = forge.md.sha1.create();
  md.update(textoUtf8, "utf8");
  return forge.util.encode64(forge.pki.privateKeyFromPem(pkeyPem).sign(md));
};

/** La del runtime (`node:crypto`). Lanza si el runtime no puede firmar RSA-SHA1. */
export const firmarConNodeCrypto: FirmaRsaSha1 = (pkeyPem, textoUtf8) =>
  createSign("RSA-SHA1").update(textoUtf8, "utf8").sign(pkeyPem, "base64");

/**
 * Qué pasó con la firma nativa en este proceso:
 *   - `sin_usar`: todavía no se firmó nada.
 *   - `comprobada`: coincidió con forge y es la que firma.
 *   - `descartada`: no coincidió o falló, y se firma con forge. `motivo` dice cuál de las dos.
 *
 * `descartada` no es un error de emisión (las firmas salen bien, por forge), pero cada
 * boleta vuelve a costar 20 ms de CPU: quien orquesta un lote tiene que avisarlo.
 */
export type EstadoFirmaNativa =
  | { estado: "sin_usar" }
  | { estado: "comprobada" }
  | { estado: "descartada"; motivo: string };

/**
 * Arma un firmador que usa `nativa` cuando ya comprobó que da lo mismo que `referencia`.
 * La comprobación es por clave: una clave nueva se comprueba de nuevo, y una nativa
 * descartada queda descartada para todas (el defecto es del runtime, no de la clave).
 *
 * Exportada para probar las tres ramas con dobles; el motor usa `firmarRsaSha1`.
 */
export function crearFirmador(
  nativa: FirmaRsaSha1,
  referencia: FirmaRsaSha1,
): { firmar: FirmaRsaSha1; estado: () => EstadoFirmaNativa } {
  // Solo se recuerda QUE la clave ya se comprobó, no la clave: un Set de PEM dejaría el
  // material privado vivo en el módulo más allá del lote que lo trajo.
  const comprobadas = new Set<string>();
  let descartada: string | null = null;

  const firmar: FirmaRsaSha1 = (pkeyPem, textoUtf8) => {
    if (descartada !== null) return referencia(pkeyPem, textoUtf8);

    let propia: string;
    try {
      propia = nativa(pkeyPem, textoUtf8);
    } catch (err) {
      descartada = `la firma nativa falló: ${err instanceof Error ? err.message : String(err)}`;
      return referencia(pkeyPem, textoUtf8);
    }

    const huella = huellaDeClave(pkeyPem);
    if (comprobadas.has(huella)) return propia;

    const esperada = referencia(pkeyPem, textoUtf8);
    if (propia !== esperada) {
      descartada = "la firma nativa no coincide con la de node-forge para la misma clave y texto";
      return esperada;
    }
    comprobadas.add(huella);
    return propia;
  };

  const estado = (): EstadoFirmaNativa => {
    if (descartada !== null) return { estado: "descartada", motivo: descartada };
    return comprobadas.size > 0 ? { estado: "comprobada" } : { estado: "sin_usar" };
  };

  return { firmar, estado };
}

/** SHA-1 del PEM: identifica la clave sin guardarla. */
function huellaDeClave(pkeyPem: string): string {
  const md = forge.md.sha1.create();
  md.update(pkeyPem);
  return md.digest().toHex();
}

const firmador = crearFirmador(firmarConNodeCrypto, firmarConForge);

/**
 * Firma RSA-SHA1 de `textoUtf8` con la clave `pkeyPem` → base64. Es la que usa el motor
 * para la firma de cada DTE. Da siempre lo que daría node-forge (ver la cabecera).
 */
export const firmarRsaSha1: FirmaRsaSha1 = firmador.firmar;

/** Si este proceso está firmando por la nativa o cayó a forge, y por qué. */
export const estadoFirmaNativa: () => EstadoFirmaNativa = firmador.estado;
