// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Arma el sobre `<EnvioDTE>` del SII —carátula `SetDTE` + los DTE ya firmados— y le pone la firma XMLDSig del SET.
 *
 * Los DTE entran tal cual (solo se les saca el prólogo `<?xml?>`): su firma individual se computó
 * standalone y acá no se re-firma. La del SET, en cambio, se calcula sobre los BYTES que se emiten
 * —el módulo reparsea su propia salida y la canonicaliza con C14N inclusiva real—, así el SII
 * recanonicaliza el sobre y llega al mismo digest. Transmite `bytes` (iso-8859-1), no `xml`: ese
 * string es Unicode y solo declara el encoding. Las guardas son tres y nada más: sobre sin DTE,
 * `setId` que no calce con `[A-Za-z_][\w.-]*`, y línea de más de 4000 chars (pasados los 4096 el SII
 * bota el sobre entero, CHR-00002). El contenido de cada DTE no se valida contra el XSD. El núcleo
 * genérico es `buildEnvioSobre(input, kind)`, que la boleta reusa desde `@ruraldte/engine/sobre-boleta`.
 *
 * @example
 * ```ts
 * import { buildEnvioDte } from "@ruraldte/engine/sobre-dte";
 *
 * const { bytes, setDigest } = buildEnvioDte({
 *   setId: "DTE_33_101",
 *   signedDtes: [signedDte], // string de buildSignedFacturaDte (@ruraldte/engine/factura), tal cual
 *   caratula: {
 *     rutEmisor: "76543210-K",
 *     rutEnvia: "22222222-2", // el RUT de la persona del certificado que firma
 *     rutReceptor: "60803000-K", // el SII
 *     fchResol: "2014-08-22",
 *     nroResol: 0,
 *     tmstFirmaEnv: "2026-09-08T11:20:31",
 *   },
 *   pfxBytes: await Deno.readFile("firma.pfx"),
 *   password: pfxPassword,
 * });
 * // `bytes` es lo que se sube al SII; `setDigest` es el DigestValue del SetDTE emitido.
 * ```
 *
 * @module
 */
// ============================================================================
// envio-dte.ts — motor genérico del SOBRE SII (SetDTE firmado).
// ============================================================================
//
// `buildEnvioSobre` arma y firma el sobre del SII que envuelve N DTE YA firmados:
//   - `<EnvioDTE>`  → factura / NC / ND / guía / factura de compra (33/34/52/56/61/46)
//   - `<EnvioBOLETA>` → boleta 39/41 (wrapper en envio-boleta.ts, producción)
//
// La carátula (`SetDTE` → `Caratula` + `SubTotDTE`), la firma XMLDSig del SetDTE
// con C14N inclusiva REAL (c14n.ts) y el tripwire de 4096 chars/línea son
// IDÉNTICOS entre boleta y DTE — solo cambian el elemento raíz y el schemaLocation.
// Por eso vive UN solo núcleo cripto acá (el bug del 505 / C14N — ver
// xml-signature.ts — enseñó que duplicar este firmado es peligroso).
//
// PRINCIPIO CLAVE — "firmar lo que se serializa": el DigestValue del SetDTE y la
// firma del SignedInfo se computan sobre los BYTES EXACTOS que emitimos (parseamos
// nuestro propio string de salida para canonicalizar). Así el SII, al recanonicalizar
// el sobre con C14N inclusiva estándar, obtiene el mismo digest → firma válida.
//
// Los DTE se incrustan VERBATIM: su firma per-DTE se computó standalone (sin ns
// heredado) y NO se re-firma. El SII valida cada DTE en ese contexto (igual que
// el oráculo de calibración, aceptado). Calibrado de estructura contra el ejemplo del SII
// `~/Documents/SII Dev/F60T33-ejemplo.xml` (factura 33 canónica).
// ============================================================================

import forge from "npm:node-forge@1.3.1";
import { canonicalize, parseXml } from "./c14n.ts";
import { encodeLatin1, sha1Base64, wrapBase64Lines } from "./xml-signature.ts";
import { extractPemFromPkcs12 } from "./pkcs12.ts";

/** Namespace del SII para DTE: es el `xmlns` por defecto del sobre y la primera mitad del `xsi:schemaLocation`. */
export const SII_NS = "http://www.sii.cl/SiiDte";
/** Namespace de XML Schema Instance. Se declara con el prefijo `xsi` en la raíz del sobre, que es lo que habilita el atributo `xsi:schemaLocation`. */
export const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";
/**
 * Namespace XMLDSig. Va como `xmlns` por defecto de la `<Signature>` que firma el SetDTE, que es hija
 * directa de la raíz del sobre y no del `<SetDTE>`: lo alcanza por `Reference URI="#setId"`, y por eso
 * redeclara el namespace en el propio elemento en vez de heredar el del SII.
 */
export const DSIG_NS = "http://www.w3.org/2000/09/xmldsig#";
/**
 * Canonical XML 1.0 inclusiva sin comentarios, la que implementa `@ruraldte/engine/c14n`. Aparece en los
 * dos puntos de la firma del SetDTE —`CanonicalizationMethod` del SignedInfo y único `Transform` de la
 * `Reference`— y está fija en el motor: no es configurable.
 */
export const C14N_ALGO = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
/** RSA-SHA1: el `SignatureMethod` de la firma del SetDTE. Está fijo en el motor, no es configurable. */
export const SIG_ALGO = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";
/** SHA-1: el `DigestMethod` de la `Reference` al SetDTE, cuyo `DigestValue` es el SHA-1 en base64 de la forma canónica del `<SetDTE>`. */
export const DIGEST_ALGO = "http://www.w3.org/2000/09/xmldsig#sha1";

/** Carátula del sobre (SetDTE). Idéntica en EnvioDTE y EnvioBOLETA. */
export type EnvioSobreCaratula = {
  /** RUT del emisor (contribuyente), ej "78416626-0". */
  rutEmisor: string;
  /** RUT de quien envía/firma (persona del cert); debe coincidir con el cert. */
  rutEnvia: string;
  /** RUT receptor del envío. Certificación/SII = "60803000-K". */
  rutReceptor: string;
  /**
   * Fecha de resolución SII (AAAA-MM-DD). En cert FACTURA = la de LA EMPRESA en
   * el ambiente de certificación (Maullín → "Consultar emisores autorizados");
   * en producción = la Res. Ex. de habilitación del emisor.
   */
  fchResol: string;
  /** Número de resolución. Certificación = 0. */
  nroResol: number;
  /** Timestamp de firma del envío (AAAA-MM-DDThh:mm:ss). */
  tmstFirmaEnv: string;
};

/**
 * Entrada de `buildEnvioSobre` y de sus dos envoltorios, `buildEnvioDte` y `buildEnvioBoleta`.
 * Los documentos llegan ya firmados y se incrustan verbatim —solo se descarta lo anterior a `<DTE`,
 * el prólogo `<?xml?>`, y el espacio final—, así que el `.pfx` se usa nada más que para la firma del
 * SetDTE: su clave privada y el certificado que va en el `KeyInfo`. Nunca para re-firmarlos.
 */
export type BuildEnvioSobreInput = {
  /** Valor del atributo ID del <SetDTE> (xs:ID: empieza con letra/_; sin ':'/espacios). */
  setId: string;
  /** DTE firmados, verbatim (cada uno `<?xml?><DTE>…</DTE>` o `<DTE>…</DTE>`). */
  signedDtes: string[];
  caratula: EnvioSobreCaratula;
  /** Bytes del .pfx (PKCS#12) para firmar el SET. */
  pfxBytes: Uint8Array;
  password: string;
};

/**
 * Sobre ya firmado: el XML como string, sus bytes de transmisión y el DigestValue del SetDTE.
 * Al SII se sube `bytes` (iso-8859-1), nunca `xml` recodificado a UTF-8: ese string es Unicode y la
 * declaración de `encoding` por sí sola no lo convierte.
 */
export type BuildEnvioSobreResult = {
  /** Sobre completo (string Unicode, declaración iso-8859-1). */
  xml: string;
  /** Bytes de transmisión (iso-8859-1). */
  bytes: Uint8Array;
  /** DigestValue del SetDTE (base64) — sobre los bytes emitidos. */
  setDigest: string;
};

/** Tipo de sobre: elemento raíz + schemaLocation del SII. */
export type SobreKind = {
  /** "EnvioDTE" (factura/NC/ND/guía/FC) | "EnvioBOLETA" (boleta). */
  rootElement: "EnvioDTE" | "EnvioBOLETA";
  /** Nombre del XSD del sobre, ej. "EnvioDTE_v10.xsd". */
  schemaLocation: string;
};

/** BigInteger forge → base64 de sus bytes big-endian (CryptoBinary xmldsig). */
function bigIntToBase64(bn: { toString(radix: number): string }): string {
  let hex = bn.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  return forge.util.encode64(forge.util.hexToBytes(hex));
}

/** Quita el prólogo `<?xml…?>` y deja desde `<DTE`. */
export function stripProlog(dte: string): string {
  const i = dte.indexOf("<DTE");
  if (i === -1) throw new Error("buildEnvioSobre: un DTE no contiene <DTE>");
  return dte.slice(i).trimEnd();
}

/** Extrae el TipoDTE (del Encabezado) de un DTE. */
export function tipoDteOf(dte: string): number {
  const m = dte.match(/<TipoDTE>(\d+)<\/TipoDTE>/);
  if (!m) throw new Error("buildEnvioSobre: DTE sin <TipoDTE>");
  return parseInt(m[1], 10);
}

/** SubTotDTE: agrupa por TipoDTE y cuenta (orden ascendente por tipo). */
export function buildSubTotDtes(dtes: string[]): string {
  const counts = new Map<number, number>();
  for (const d of dtes) {
    const t = tipoDteOf(d);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tipo, n]) =>
      `<SubTotDTE>\r\n<TpoDTE>${tipo}</TpoDTE>\r\n<NroDTE>${n}</NroDTE>\r\n</SubTotDTE>\r\n`
    )
    .join("");
}

// deno-lint-ignore no-explicit-any
function elementById(doc: any, tag: string, id: string): any {
  const els = doc.getElementsByTagName(tag);
  for (let i = 0; i < els.length; i++) if (els[i].getAttribute("ID") === id) return els[i];
  throw new Error(`elementById: <${tag} ID="${id}"> no encontrado`);
}

/** SignedInfo de la firma del SET (la <Signature> hija directa del elemento raíz). */
// deno-lint-ignore no-explicit-any
function setSignedInfo(doc: any, rootElement: string): any {
  const sigs = doc.getElementsByTagName("Signature");
  for (let i = 0; i < sigs.length; i++) {
    if (sigs[i].parentNode && sigs[i].parentNode.nodeName === rootElement) {
      return sigs[i].getElementsByTagName("SignedInfo")[0];
    }
  }
  throw new Error("setSignedInfo: firma del SET no encontrada");
}

/**
 * Arma el sobre del SII (`<EnvioDTE>` / `<EnvioBOLETA>`) con N DTE firmados y lo
 * firma (XMLDSig sobre el SetDTE) con la C14N inclusiva real. Devuelve string +
 * bytes iso-8859-1.
 */
export function buildEnvioSobre(
  input: BuildEnvioSobreInput,
  kind: SobreKind,
): BuildEnvioSobreResult {
  if (input.signedDtes.length === 0) throw new Error("buildEnvioSobre: sin DTE");
  if (!/^[A-Za-z_][\w.-]*$/.test(input.setId)) {
    throw new Error(`buildEnvioSobre: setId inválido como xs:ID: "${input.setId}"`);
  }
  const c = input.caratula;
  const root = kind.rootElement;
  const dtes = input.signedDtes.map(stripProlog);

  const head = `<?xml version="1.0" encoding="ISO-8859-1"?>\r\n` +
    `<${root} xmlns:xsi="${XSI_NS}" xsi:schemaLocation="${SII_NS} ${kind.schemaLocation}" ` +
    `version="1.0" xmlns="${SII_NS}">\r\n`;

  const caratula = `<Caratula version="1.0">\r\n` +
    `<RutEmisor>${c.rutEmisor}</RutEmisor>\r\n` +
    `<RutEnvia>${c.rutEnvia}</RutEnvia>\r\n` +
    `<RutReceptor>${c.rutReceptor}</RutReceptor>\r\n` +
    `<FchResol>${c.fchResol}</FchResol>\r\n` +
    `<NroResol>${c.nroResol}</NroResol>\r\n` +
    `<TmstFirmaEnv>${c.tmstFirmaEnv}</TmstFirmaEnv>\r\n` +
    buildSubTotDtes(dtes) +
    `</Caratula>\r\n`;

  // Layout calibrado contra el sobre real del oráculo de calibración (SII-aceptado): los DTE
  // (que ya vienen pretty + Signature compacta de signBoletaDte) se concatenan
  // SIN separador — cada uno abre `<DTE version="1.0">\r\n`, así la frontera
  // queda `…</Signature></DTE><DTE version="1.0">\r\n` igual que el oráculo —
  // y `</SetDTE>` pega directo al último `</DTE>`.
  const setDte = `<SetDTE ID="${input.setId}">\r\n${caratula}${dtes.join("")}</SetDTE>`;

  // --- firma del SET con C14N real ---
  const { certPem, pkeyPem } = extractPemFromPkcs12(input.pfxBytes, input.password);
  const privateKey = forge.pki.privateKeyFromPem(pkeyPem);
  const certificate = forge.pki.certificateFromPem(certPem);

  // 1) DigestValue del SetDTE (in-envelope, sobre los bytes que emitiremos).
  const digestDoc = parseXml(`${head}${setDte}\r\n</${root}>`);
  const setDigest = sha1Base64(canonicalize(elementById(digestDoc, "SetDTE", input.setId)));

  // 2) KeyInfo (modulus/exponent + cert DER).
  const pub = certificate.publicKey;
  const modulus = bigIntToBase64(pub.n);
  const exponent = bigIntToBase64(pub.e);
  const x509 = forge.util.encode64(
    forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes(),
  );

  // 3) SignedInfo + <Signature> con SignatureValue placeholder.
  const signedInfo = `<SignedInfo>` +
    `<CanonicalizationMethod Algorithm="${C14N_ALGO}"/>` +
    `<SignatureMethod Algorithm="${SIG_ALGO}"/>` +
    `<Reference URI="#${input.setId}">` +
    `<Transforms><Transform Algorithm="${C14N_ALGO}"/></Transforms>` +
    `<DigestMethod Algorithm="${DIGEST_ALGO}"/>` +
    `<DigestValue>${setDigest}</DigestValue>` +
    `</Reference></SignedInfo>`;
  const PLACEHOLDER = "__SET_SIGVALUE__";
  // Signature COMPACTA (whitespace entre sus hijos → "LPX-00007: unexpected
  // EOF" del SII, observado vivo); el tope de 4096 chars/línea se respeta
  // envolviendo el base64 del X509 a 76 cols (forma del oráculo de calibración).
  const signature = `<Signature xmlns="${DSIG_NS}">${signedInfo}` +
    `<SignatureValue>${PLACEHOLDER}</SignatureValue>` +
    `<KeyInfo><KeyValue><RSAKeyValue>` +
    `<Modulus>${modulus}</Modulus><Exponent>${exponent}</Exponent>` +
    `</RSAKeyValue></KeyValue>` +
    `<X509Data><X509Certificate>${
      wrapBase64Lines(x509)
    }</X509Certificate></X509Data></KeyInfo></Signature>`;

  // 4) Ensamblar y firmar el SignedInfo (in-context → hereda xmldsig# + xsi).
  const full = `${head}${setDte}\r\n${signature}</${root}>`;
  const siC14n = canonicalize(setSignedInfo(parseXml(full), root));
  const md = forge.md.sha1.create();
  md.update(siC14n, "utf8");
  const signatureValue = forge.util.encode64(privateKey.sign(md));

  const xml = full.replace(PLACEHOLDER, signatureValue);

  // Tripwire: el SII rechaza el sobre entero si alguna línea supera 4096 chars
  // (CHR-00002). Mejor fallar acá con contexto que recibir un RSC de Maullín.
  const longLine = xml.split(/\r?\n/).find((l) => l.length > 4000);
  if (longLine) {
    throw new Error(
      `buildEnvioSobre: línea de ${longLine.length} chars supera el tope SII (4096): ` +
        `"${longLine.slice(0, 80)}…" — falta un corte de línea estructural`,
    );
  }

  return { xml, bytes: encodeLatin1(xml), setDigest };
}

/** Tipo del sobre EnvioDTE (factura/NC/ND/guía/FC). */
export const ENVIO_DTE_KIND: SobreKind = {
  rootElement: "EnvioDTE",
  schemaLocation: "EnvioDTE_v10.xsd",
};

/**
 * Arma el sobre `<EnvioDTE>` (factura 33/34, NC 61, ND 56, guía 52, FC 46) con N
 * DTE firmados y lo firma. Misma carátula/firma que boleta; raíz EnvioDTE +
 * schemaLocation EnvioDTE_v10.xsd. Estructura verificada vs el oráculo F60T33.
 */
export function buildEnvioDte(input: BuildEnvioSobreInput): BuildEnvioSobreResult {
  return buildEnvioSobre(input, ENVIO_DTE_KIND);
}
