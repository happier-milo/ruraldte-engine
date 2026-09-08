// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Extrae el certificado y la clave privada de un PKCS#12 (.pfx / .p12) protegido por contraseña y los devuelve como PEM.
 *
 * Corre sobre node-forge (JS puro): sirve en Deno edge, sin OpenSSL ni shell. De un .pfx con la
 * cadena completa toma el primer cert sin `basicConstraints CA:TRUE`. Los fallos previstos salen
 * como `Pkcs12ExtractError` con un `code` estable y sin la contraseña en el mensaje, pero forge no
 * distingue contraseña mala de archivo corrupto: `wrong_password` es una lectura de su mensaje de
 * error, no un veredicto. El resultado se memoiza en un WeakMap por IDENTIDAD de la instancia
 * `Uint8Array` (más la contraseña), así que un `.slice()` del mismo contenido es un miss que
 * re-extrae. No valida vigencia ni cadena de confianza: `expiresAt` es solo el `notAfter` del cert,
 * y `rutFromCert` queda en `null` si el subject no trae `serialNumber` o si no viene en formato
 * `12345678-K` (con puntos no calza).
 *
 * @example
 * ```ts
 * import { extractPemFromPkcs12, Pkcs12ExtractError } from "@ruraldte/engine/pkcs12";
 *
 * const pfx = await Deno.readFile("./76543210-K.pfx");
 * try {
 *   const cred = extractPemFromPkcs12(pfx, Deno.env.get("PFX_PASSWORD")!);
 *   console.log(cred.certSubject, cred.rutFromCert, cred.expiresAt);
 *   // cred.certPem + cred.pkeyPem son el material con que se firma el DTE: no loguearlos
 * } catch (err) {
 *   if (err instanceof Pkcs12ExtractError && err.code === "wrong_password") {
 *     // 422 al usuario: pídele la contraseña del cert de nuevo
 *   }
 *   throw err;
 * }
 * ```
 *
 * @module
 */
// ============================================================================
// PKCS#12 (.pfx / .p12) helpers — extracción de cert y clave privada a PEM.
// ============================================================================
//
// API Gateway requiere los strings PEM (`cert-data` + `pkey-data`) en el body
// de cada request de emisión. El usuario sube su archivo .pfx + contraseña;
// nosotros extraemos los PEM server-side y guardamos en Vault.
//
// node-forge se carga vía `npm:node-forge@1.3.1` — verificado en Deno edge
// runtime 2026-05-07. Sin shell access (Deno edge no permite `Deno.run`),
// node-forge es la mejor opción JS pura.
//
// Errores explícitos sin filtrar la contraseña en el mensaje:
//   - PKCS12 inválido (magic bytes, asn.1 parse)
//   - Contraseña incorrecta (forge lanza un error genérico — lo traducimos)
//   - PKCS12 sin cert o sin clave privada
// ============================================================================

import forge from "npm:node-forge@1.3.1";

/**
 * Certificado del titular y su clave privada ya extraídos de un .pfx, en PEM, más los datos que trae el propio cert.
 * `certPem` y `pkeyPem` son el material con que se firma el DTE: no los loguees ni los devuelvas al cliente. `expiresAt`
 * es el `notAfter` del cert, no un veredicto de vigencia (nadie validó la cadena); `certSubject` queda en `""` si el cert
 * no trae CN, y `rutFromCert` en `null` si el subject no trae el RUT o si no viene en formato `76543210-K` (con puntos
 * no calza).
 */
export type ExtractedPkcs12 = {
  /** Cert PEM (BEGIN CERTIFICATE...END CERTIFICATE) */
  certPem: string;
  /** Private key PEM (BEGIN PRIVATE KEY...END PRIVATE KEY) — formato PKCS#8 */
  pkeyPem: string;
  /** Distinguished name del subject (CN). */
  certSubject: string;
  /** ISO 8601 expiration. */
  expiresAt: string;
  /** RUT extraído del cert subject si está presente (Chile cert digital tributario). */
  rutFromCert: string | null;
};

/**
 * Falla prevista al abrir un PKCS#12, con un `code` estable (`invalid_format`, `wrong_password`, `missing_cert`,
 * `missing_pkey`, `extraction_failed`) para decidir qué mensaje mostrarle al usuario.
 * Los mensajes que arma este módulo no llevan la contraseña, pero los de `invalid_format` y `extraction_failed` pueden
 * arrastrar el texto de error de la librería de criptografía; y `wrong_password` es una interpretación de ese texto
 * —la librería no distingue contraseña incorrecta de archivo corrupto—, no una certeza.
 */
export class Pkcs12ExtractError extends Error {
  /** Código estable para mostrar mensaje correcto al usuario. */
  code:
    | "invalid_format"
    | "wrong_password"
    | "missing_cert"
    | "missing_pkey"
    | "extraction_failed";
  constructor(code: Pkcs12ExtractError["code"], message: string) {
    super(message);
    this.name = "Pkcs12ExtractError";
    this.code = code;
  }
}

/**
 * Verifica magic bytes PKCS#12 (ASN.1 SEQUENCE con length long-form).
 * - Byte 0: 0x30 (SEQUENCE tag)
 * - Byte 1: 0x80-0x88 (long-form length: 0x80=indefinite BER, 0x81-0x88=
 *   N bytes de length DER). Algunos certs (e.g. los de Acepta Chile) usan
 *   BER 0x80; otros (e-CertChile) usan DER 0x82. Aceptamos cualquier
 *   long-form para no rechazar certs válidos.
 */
export function looksLikePkcs12(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x30 &&
    (bytes[1] & 0x80) === 0x80
  );
}

/**
 * Extrae RUT desde subject del cert. En cert digital chileno (Acepta, FirmaDOX,
 * etc.) el RUT vive en el atributo SerialNumber del subject. Probamos ambas
 * formas de match (name + OID 2.5.4.5) por si la CA emisora usa una u otra.
 */
function extractRutFromSubject(subject: forge.pki.Certificate["subject"]): string | null {
  const candidates = [
    subject.getField("serialNumber"),
    subject.getField({ type: "2.5.4.5" }),
  ];
  for (const attr of candidates) {
    if (!attr) continue;
    const value = (attr as { value?: unknown }).value;
    if (typeof value !== "string") continue;
    const cleaned = value.trim();
    if (/^\d{1,8}-[\dkK]$/.test(cleaned)) return cleaned;
  }
  return null;
}

// ── Memoización por identidad de bytes (auditoría A2) ───────────────────────
//
// extractPemFromPkcs12 es PURO pero CARÍSIMO: ASN.1 + PBKDF2 en JS puro (~decenas-
// cientos de ms). Un mismo documento la invoca ~2 veces (firma del DTE + del sobre)
// sobre EL MISMO .pfx, y un lote de un emisor la repite por cada doc. El worker
// cachea el material descifrado por emisor/tick (readCredentialCached) y pasa SIEMPRE
// la misma instancia Uint8Array → memoizamos por IDENTIDAD de esa instancia con un
// WeakMap. Consecuencias:
//   · Se parsea 1 vez por credencial y por tick (corta ~60-70% del CPU por doc).
//   · Custodia intacta: el resultado vive EXACTAMENTE lo que viven los bytes; cuando
//     el credCache del tick se libera, la entrada del WeakMap desaparece con GC. No
//     hay retención cross-tick ni material logueado.
//   · Fail-safe: un miss (instancia distinta, ej. token con bytes frescos) simplemente
//     re-extrae — nunca devuelve el material de otra credencial (la clave es la propia
//     instancia + el password). Los errores NO se cachean (lanzan antes de guardar).
const _pemMemo = new WeakMap<Uint8Array, Map<string, ExtractedPkcs12>>();

/**
 * Abre un .pfx / .p12 con su contraseña y devuelve el certificado del titular y su clave privada en PEM; de un archivo
 * con la cadena completa toma el primer cert sin `basicConstraints CA:TRUE`, y si todos son CA cae al primero.
 * El resultado se memoiza por IDENTIDAD de la instancia `Uint8Array` (más la contraseña) en un `WeakMap`: pasar un
 * `.slice()` con los mismos bytes es un miss y vuelve a extraer, y los errores no se cachean. Cuando hay hit devuelve
 * el mismo objeto, así que no lo mutes.
 *
 * @param bytes contenido crudo del archivo .pfx / .p12; si lo tienes en base64, decodifícalo antes
 * @param password contraseña que protege el .pfx
 * @returns cert y clave en PEM, el CN del subject, la expiración en ISO 8601 y el RUT del cert cuando viene
 * @throws {Pkcs12ExtractError} `invalid_format` si los bytes no parten como ASN.1 de un PKCS#12, `wrong_password` si
 *   el descifrado falla con pinta de contraseña mala, `missing_cert` / `missing_pkey` si adentro no hay certificado o
 *   no hay clave privada, y `extraction_failed` en cualquier otro fallo al descifrar o al serializar el PEM
 */
export function extractPemFromPkcs12(
  bytes: Uint8Array,
  password: string,
): ExtractedPkcs12 {
  const byPw = _pemMemo.get(bytes);
  const hit = byPw?.get(password);
  if (hit) return hit;
  const result = extractPemFromPkcs12Uncached(bytes, password);
  const map = byPw ?? new Map<string, ExtractedPkcs12>();
  map.set(password, result);
  if (!byPw) _pemMemo.set(bytes, map);
  return result;
}

/**
 * Extrae cert PEM + pkey PEM desde un archivo .pfx + password.
 * Errores tipados para que el caller pueda dar mensajes útiles al usuario.
 * (Sin caché — la memoización vive en extractPemFromPkcs12 de arriba.)
 */
function extractPemFromPkcs12Uncached(
  bytes: Uint8Array,
  password: string,
): ExtractedPkcs12 {
  if (!looksLikePkcs12(bytes)) {
    throw new Pkcs12ExtractError(
      "invalid_format",
      "El archivo no parece un PKCS#12 válido (.pfx / .p12)",
    );
  }

  // Convert Uint8Array → forge ByteBuffer (binary string). node-forge espera
  // un string donde cada char-code es un byte. Esto NO es UTF-8 decode.
  let binaryString = "";
  for (let i = 0; i < bytes.length; i++) {
    binaryString += String.fromCharCode(bytes[i]);
  }

  // Parse ASN.1
  let asn1;
  try {
    asn1 = forge.asn1.fromDer(binaryString);
  } catch (err) {
    throw new Pkcs12ExtractError(
      "invalid_format",
      `ASN.1 parse falló: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Decrypt + parse PKCS#12 con la contraseña
  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch (err) {
    // forge no diferencia "wrong password" de "corrupt", pero el caso típico
    // del usuario es contraseña errónea. Damos esa interpretación primero.
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("PKCS#12 MAC") ||
      msg.includes("Invalid password") ||
      msg.includes("invalid password") ||
      msg.includes("decrypt")
    ) {
      throw new Pkcs12ExtractError(
        "wrong_password",
        "Contraseña del cert digital incorrecta",
      );
    }
    throw new Pkcs12ExtractError(
      "extraction_failed",
      `Error al desencriptar .pfx: ${msg}`,
    );
  }

  // Extract cert (un .pfx puede traer la cadena completa CA — tomamos el cert
  // del titular, distinguido por NO tener basicConstraints CA:TRUE)
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[
    forge.pki.oids.certBag
  ];
  if (!certBags || certBags.length === 0) {
    throw new Pkcs12ExtractError("missing_cert", "PKCS#12 sin certificado");
  }

  // Pick the leaf cert (not CA)
  let chosenCert: forge.pki.Certificate | null = null;
  for (const bag of certBags) {
    if (!bag.cert) continue;
    const isCa = (bag.cert.extensions ?? []).some(
      (ext: { name?: string; cA?: boolean }) =>
        ext.name === "basicConstraints" && ext.cA === true,
    );
    if (!isCa) {
      chosenCert = bag.cert;
      break;
    }
  }
  if (!chosenCert && certBags[0]?.cert) chosenCert = certBags[0].cert;
  if (!chosenCert) {
    throw new Pkcs12ExtractError("missing_cert", "PKCS#12 sin certificado válido");
  }

  // Extract private key
  const pkeyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
    forge.pki.oids.pkcs8ShroudedKeyBag
  ];
  const fallbackPkeyBags = p12.getBags({ bagType: forge.pki.oids.keyBag })[
    forge.pki.oids.keyBag
  ];
  const pkeyBag = (pkeyBags && pkeyBags[0]) || (fallbackPkeyBags && fallbackPkeyBags[0]);
  if (!pkeyBag || !pkeyBag.key) {
    throw new Pkcs12ExtractError(
      "missing_pkey",
      "PKCS#12 sin clave privada (puede ser un cert solo público)",
    );
  }

  let certPem: string;
  let pkeyPem: string;
  try {
    certPem = forge.pki.certificateToPem(chosenCert);
    pkeyPem = forge.pki.privateKeyToPem(pkeyBag.key);
  } catch (err) {
    throw new Pkcs12ExtractError(
      "extraction_failed",
      `PEM serialization falló: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Subject CN
  const cnAttr = chosenCert.subject.getField("CN") as { value?: string } | null;
  const certSubject = (cnAttr?.value ?? "").trim();
  const expiresAt = chosenCert.validity.notAfter.toISOString();
  const rutFromCert = extractRutFromSubject(chosenCert.subject);

  return { certPem, pkeyPem, certSubject, expiresAt, rutFromCert };
}
