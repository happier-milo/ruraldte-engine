// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Firma XMLDSig enveloped (RSA-SHA1) de documentos SII y verificación de los sobres que llegan de terceros.
 *
 * Los algoritmos no se eligen: C14N 1.0 inclusive, rsa-sha1 y sha1. `verifyInboundEnvio` además exige firma y digest
 * contra una allowlist —un sobre con SignatureMethod sha256 se rechaza—, y lo que emite `signDte` está calibrado byte
 * a byte contra un sobre que el SII aceptó: no lo reformatees, whitespace entre los hijos de la Signature o una línea
 * sobre 4096 chars y el envío rebota. El string sale con declaración iso-8859-1, pero los bytes de transmisión los da
 * `encodeLatin1`. Del lado entrante, `signatureOk` prueba integridad y que el cert esté dentro de su vigencia; NO
 * valida cadena de confianza ni revocación, y cotejar `signerRut` con `rutEnvia` te toca a ti.
 *
 * @example
 * ```ts
 * import { encodeLatin1, signDte, verifyInboundEnvio } from "@ruraldte/engine/firma";
 *
 * // documentoXml = el <Documento ID="F100T33"> compacto que arma el builder (factura, boleta, guía...).
 * const dteXml = signDte(documentoXml, "F100T33", pfxBytes, pfxPassword);
 * await Deno.writeFile("F100T33.xml", encodeLatin1(dteXml)); // bytes iso-8859-1, no UTF-8
 *
 * // Sobre recibido: manda la firma, no la carátula. El binding firmante↔remitente es tuyo
 * // (normaliza el formato de los RUT antes de compararlos).
 * const v = verifyInboundEnvio(sobreRecibido);
 * if (v.envelopeOk && v.signerRut === v.rutEnvia && v.dtes[0].signatureOk) {
 *   console.log(v.dtes[0].tipoDte, v.dtes[0].folio, v.dtes[0].correoEmisor);
 * }
 * ```
 *
 * @module
 */
// ============================================================================
// Firma XMLDSig (enveloped) para documentos SII — RSA-SHA1.
// ============================================================================
//
// El SII firma sus DTE/sobres/RCOF con XML Signature *enveloped*:
//   - Canonicalización: C14N 1.0 inclusive (xml-c14n-20010315)
//   - SignatureMethod:  rsa-sha1
//   - DigestMethod:     sha1
//   - Transform:        enveloped-signature
//   - KeyInfo:          RSAKeyValue (Modulus/Exponent) + X509Certificate
//
// Hoy esa firma la hace el oráculo de calibración dentro de `dte/generar`. Para el RCOF
// (Consumo de Folios) — que el oráculo de calibración NO expone — la hacemos nosotros.
//
// ESTRATEGIA C14N (robusta porque controlamos la generación del XML):
//   - El XML a firmar se genera COMPACTO (sin whitespace entre tags) y sin
//     prefijos de namespace → la canonicalización C14N es casi identidad.
//   - Único ajuste C14N necesario: al canonicalizar un sub-árbol, se le
//     propaga el namespace por defecto heredado del ancestro. Lo inyectamos
//     explícitamente (`xmlns="…"`) en el elemento ápice antes de calcular el
//     digest / la firma. C14N ordena los xmlns ANTES de los atributos.
//
// ⚠️ Validación final contra el SII: el roundtrip cripto (firmar→verificar con
// la misma C14N) está cubierto por tests, pero la aceptación byte-exacta la da
// recién Maullin. Por eso el envío del RCOF en certificación es UPLOAD MANUAL
// en el portal — generamos+firmamos acá y se sube a mano.
//
// node-forge@1.3.1 ya es dependencia verificada en el edge runtime Deno.
// ============================================================================

import forge from "npm:node-forge@1.3.1";
import { canonicalize, parseXml } from "./c14n.ts";
import { extractPemFromPkcs12 } from "./pkcs12.ts";

const C14N_ALGO = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const SIG_ALGO = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";
const DIGEST_ALGO = "http://www.w3.org/2000/09/xmldsig#sha1";
const ENVELOPED_ALGO = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const DSIG_NS = "http://www.w3.org/2000/09/xmldsig#";

/**
 * Transform de la Reference. "enveloped" (RCOF, default histórico) vs "c14n"
 * (boleta DTE — espeja al oráculo de calibración, cuyo TED el SII acepta). El digest final es
 * el mismo (C14N del subárbol; la firma está fuera del Documento, el enveloped es
 * no-op acá), pero matcheamos el formato del proveedor probado.
 */
type RefTransform = "enveloped" | "c14n";

// ---------- Primitivas cripto (node-forge) ----------------------------------

/** SHA1 de un string (UTF-8) → base64. */
export function sha1Base64(input: string): string {
  const md = forge.md.sha1.create();
  md.update(input, "utf8");
  return forge.util.encode64(md.digest().getBytes());
}

/** BigInteger forge → base64 de sus bytes big-endian (CryptoBinary xmldsig). */
function bigIntToBase64(bn: { toString(radix: number): string }): string {
  let hex = bn.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  return forge.util.encode64(forge.util.hexToBytes(hex));
}

// ---------- Canonicalización -------------------------------------------------

/**
 * Canonicaliza un sub-árbol que hereda un namespace por defecto del ancestro:
 * inyecta `xmlns="<ns>"` en el elemento ápice, como primer pseudo-atributo
 * (C14N: namespace nodes antes que atributos).
 *
 * Asume XML compacto sin prefijos (lo que genera consumo-folios.ts). El ápice
 * tiene forma `<TAG ...attrs...>...`. Inserta el xmlns justo tras `<TAG`.
 */
export function injectInheritedNamespace(
  subtreeXml: string,
  apexTag: string,
  namespace: string,
): string {
  const open = `<${apexTag}`;
  if (!subtreeXml.startsWith(open)) {
    throw new Error(
      `injectInheritedNamespace: el sub-árbol no empieza con <${apexTag}`,
    );
  }
  // Si ya trae xmlns, no duplicar.
  const headEnd = subtreeXml.indexOf(">");
  const head = subtreeXml.slice(0, headEnd);
  if (/\bxmlns\s*=/.test(head)) return subtreeXml;
  return (
    open + ` xmlns="${namespace}"` + subtreeXml.slice(open.length)
  );
}

/** Extrae el sub-árbol `<TAG ...>...</TAG>` (única ocurrencia) de un XML. */
export function extractElement(xml: string, tag: string): string {
  const startMatch = xml.indexOf(`<${tag}`);
  if (startMatch === -1) throw new Error(`extractElement: <${tag}> no encontrado`);
  const closeTag = `</${tag}>`;
  const closeIdx = xml.indexOf(closeTag, startMatch);
  if (closeIdx === -1) throw new Error(`extractElement: ${closeTag} no encontrado`);
  return xml.slice(startMatch, closeIdx + closeTag.length);
}

// ---------- Ensamblado de la firma ------------------------------------------

/**
 * Los seis valores ya calculados que `buildSignatureElement` interpola dentro del bloque `<Signature>`:
 * el ID que va al `URI="#…"` de la Reference, más digest, firma, modulus, exponente y certificado en
 * base64. Se pegan tal cual, sin recortar ni envolver, y la Signature sale compacta en una sola línea,
 * así que el base64 del certificado tiene que llegar ya cortado con `wrapBase64Lines`: el validador del
 * SII rechaza el documento si una línea pasa los 4096 chars ("CHR-00002: Line too long").
 */
type SignatureParts = {
  signedElementId: string;
  digestValueBase64: string;
  signatureValueBase64: string;
  modulusBase64: string;
  exponentBase64: string;
  x509Base64: string;
};

/** SignedInfo SIN xmlns (para embeber dentro de <Signature>, hereda el ns). */
function buildSignedInfoInner(
  signedElementId: string,
  digestValueBase64: string,
  transform: RefTransform = "enveloped",
): string {
  const transformAlgo = transform === "c14n" ? C14N_ALGO : ENVELOPED_ALGO;
  return (
    `<SignedInfo>` +
    `<CanonicalizationMethod Algorithm="${C14N_ALGO}"/>` +
    `<SignatureMethod Algorithm="${SIG_ALGO}"/>` +
    `<Reference URI="#${signedElementId}">` +
    `<Transforms><Transform Algorithm="${transformAlgo}"/></Transforms>` +
    `<DigestMethod Algorithm="${DIGEST_ALGO}"/>` +
    `<DigestValue>${digestValueBase64}</DigestValue>` +
    `</Reference>` +
    `</SignedInfo>`
  );
}

/**
 * Ensambla el bloque <Signature> completo (string compacto).
 *
 * ⚠️ NO insertar whitespace entre los hijos de <Signature>: el validador del
 * SII responde "LPX-00007: unexpected end-of-file" ante esa forma (observado
 * vivo en Maullín 2026-06-10). La forma aceptada (oráculo de calibración) es la
 * Signature COMPACTA; para el tope de 4096 chars/línea lo que se corta es el
 * base64 del X509 (wrapBase64Lines), nunca la estructura.
 */
export function buildSignatureElement(
  parts: SignatureParts,
  transform: RefTransform = "enveloped",
): string {
  const signedInfo = buildSignedInfoInner(
    parts.signedElementId,
    parts.digestValueBase64,
    transform,
  );
  return (
    `<Signature xmlns="${DSIG_NS}">` +
    signedInfo +
    `<SignatureValue>${parts.signatureValueBase64}</SignatureValue>` +
    `<KeyInfo>` +
    `<KeyValue><RSAKeyValue>` +
    `<Modulus>${parts.modulusBase64}</Modulus>` +
    `<Exponent>${parts.exponentBase64}</Exponent>` +
    `</RSAKeyValue></KeyValue>` +
    `<X509Data><X509Certificate>${parts.x509Base64}</X509Certificate></X509Data>` +
    `</KeyInfo>` +
    `</Signature>`
  );
}

/**
 * Envuelve un base64 en líneas de `width` chars con CRLF (forma PEM-style que
 * emite el oráculo de calibración dentro de <X509Certificate> y que el SII acepta). xs:base64Binary
 * admite whitespace; así ninguna línea del documento supera el tope de 4096.
 */
export function wrapBase64Lines(b64: string, width = 76): string {
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += width) chunks.push(b64.slice(i, i + width));
  return chunks.join("\r\n");
}

// ---------- Firma con clave forge (núcleo testeable) -------------------------

/**
 * Par clave privada + certificado ya parseados con node-forge (`pki.rsa.PrivateKey` y `pki.Certificate`),
 * que es lo que firma `signXmlWithForgeKey`. Tienen que corresponder entre sí: el `KeyInfo` (Modulus,
 * Exponent y X509Certificate) se arma desde el certificado y la firma la calcula la clave privada, así
 * que un par cruzado produce un XML cuya firma no verifica. Si partes de un .pfx, usa `signSiiXml`, que
 * extrae ambos por ti.
 */
export type ForgeKeyMaterial = {
  // deno-lint-ignore no-explicit-any
  privateKey: any; // forge.pki.rsa.PrivateKey
  // deno-lint-ignore no-explicit-any
  certificate: any; // forge.pki.Certificate
};

/**
 * Firma enveloped un XML que tiene un elemento firmable identificado por `ID`.
 * Núcleo puro-cripto: recibe la clave/cert ya parseados (forge) → testeable
 * con un par generado en el test, sin .pfx real.
 *
 * @param xml             XML sin firma (compacto, sin prefijos).
 * @param signedElementTag  ej. "DocumentoConsumoFolios".
 * @param signedElementId   valor del atributo ID del elemento firmado.
 * @param signedElementNs   namespace heredado a inyectar para C14N (ej. SiiDte).
 */
export function signXmlWithForgeKey(
  xml: string,
  signedElementTag: string,
  signedElementId: string,
  signedElementNs: string,
  key: ForgeKeyMaterial,
  opts: { transform?: RefTransform; injectNs?: boolean } = {},
): string {
  const transform = opts.transform ?? "enveloped";
  // 1. Digest del elemento referenciado: C14N REAL del elemento EN SU CONTEXTO
  //    (parsea el documento completo — la C14N inclusiva emite en el ápice TODOS
  //    los namespaces heredados del root, ej. xmlns SiiDte + xmlns:xsi del
  //    schemaLocation). Es el patrón "firmar lo que se serializa" que el SII ya
  //    validó en la firma del SET (FOK) y la forma que firma otra implementación (RCOF
  //    aceptado por el SII). Firmar el subárbol extraído SIN contexto divergía
  //    apenas el root declarara xmlns:xsi.
  const docTree = parseXml(xml);
  const signedEl = docTree.getElementsByTagName(signedElementTag)[0];
  if (!signedEl) {
    throw new Error(`signXmlWithForgeKey: <${signedElementTag}> no encontrado`);
  }
  const digestValueBase64 = sha1Base64(canonicalize(signedEl));

  // 2-3. Firma en DOS fases (igual que envio-boleta.ts): se ensambla el documento
  //    CON la Signature (SignatureValue placeholder), se parsea, y el SignedInfo
  //    se canonicaliza EN CONTEXTO → RSA-SHA1. ⚠️ NO firmar strings crudos: el
  //    C14N expande tags autocerrados (<X/>→<X></X>) y agrega ns heredados — la
  //    firma sobre la forma cruda rebota "505 Firma DTE Incorrecta" (verificado
  //    VIVO 2026-06-12, track 28074483).
  const PLACEHOLDER = "__SIIXML_SIGVALUE__";

  // KeyInfo (modulus/exponent + cert DER). El X509 va envuelto a 76 cols
  // (igual que el sobre): el gateway legacy es line-based con tope ~4096 —
  // un base64 de ~2300 chars en una línea contribuye a romper su lectura.
  const pub = key.certificate.publicKey;
  const modulusBase64 = bigIntToBase64(pub.n);
  const exponentBase64 = bigIntToBase64(pub.e);
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(key.certificate)).getBytes();
  const x509Base64 = wrapBase64Lines(forge.util.encode64(certDer));

  // Ensamblar la firma (SignatureValue placeholder) e insertarla tras el cierre.
  const signature = buildSignatureElement({
    signedElementId,
    digestValueBase64,
    signatureValueBase64: PLACEHOLDER,
    modulusBase64,
    exponentBase64,
    x509Base64,
  }, transform);

  const closeTag = `</${signedElementTag}>`;
  const insertAt = xml.indexOf(closeTag);
  if (insertAt === -1) {
    throw new Error(`signXmlWithForgeKey: ${closeTag} no encontrado para insertar la firma`);
  }
  const pos = insertAt + closeTag.length;
  const full = xml.slice(0, pos) + signature + xml.slice(pos);

  // Firmar el SignedInfo COMO QUEDÓ EN EL DOCUMENTO (C14N en contexto).
  const fullTree = parseXml(full);
  const signedInfoEl = fullTree.getElementsByTagName("SignedInfo")[0];
  if (!signedInfoEl) throw new Error("signXmlWithForgeKey: SignedInfo no encontrado");
  const md = forge.md.sha1.create();
  md.update(canonicalize(signedInfoEl), "utf8");
  const signatureValueBase64 = forge.util.encode64(key.privateKey.sign(md));

  return full.replace(PLACEHOLDER, signatureValueBase64);
}

/**
 * Verifica una firma producida por `signXmlWithForgeKey` re-canonicalizando el
 * SignedInfo y validando contra la clave pública. NO prueba compatibilidad con
 * el SII (misma C14N de ida y vuelta) — sirve para tests de consistencia interna.
 */
export function verifyForgeSignature(
  signedXml: string,
  // deno-lint-ignore no-explicit-any
  publicKey: any,
): boolean {
  // C14N del SignedInfo EN SU CONTEXTO (documento completo) — la misma forma
  // que firma signXmlWithForgeKey y que recanonicaliza el SII.
  const signedInfoEl = parseXml(signedXml).getElementsByTagName("SignedInfo")[0];
  if (!signedInfoEl) throw new Error("verifyForgeSignature: SignedInfo no encontrado");
  const canonicalSignedInfo = canonicalize(signedInfoEl);
  const sigValMatch = signedXml.match(/<SignatureValue>([^<]+)<\/SignatureValue>/);
  if (!sigValMatch) throw new Error("verifyForgeSignature: SignatureValue no encontrado");
  const signatureBytes = forge.util.decode64(sigValMatch[1]);
  const md = forge.md.sha1.create();
  md.update(canonicalSignedInfo, "utf8");
  try {
    return publicKey.verify(md.digest().getBytes(), signatureBytes);
  } catch {
    // Firma corrupta: forge lanza al decodificar el padding PKCS#1 → es inválida.
    return false;
  }
}

// ---------- Verificación de un EnvioDTE RECIBIDO (intercambio entrante, A3) ---

// RUT del subject del cert (Chile: atributo SerialNumber / OID 2.5.4.5).
function rutFromCertSubject(cert: forge.pki.Certificate): string | null {
  const f = cert.subject.getField("serialNumber") ?? cert.subject.getField({ type: "2.5.4.5" });
  const v = (f as { value?: string } | null)?.value;
  return v && v.trim() ? v.trim() : null;
}

// Transforms permitidos en la Reference de una firma de DTE/sobre SII. Cualquier
// otro (XPath, XSLT) podría alterar QUÉ bytes entran al digest → se rechaza.
const ALLOWED_REF_TRANSFORMS = new Set([ENVELOPED_ALGO, C14N_ALGO]);

// SII profile: la firma DTE/sobre es SIEMPRE rsa-sha1 + sha1 (perfil xmldsig del SII).
// Pinneamos el set ACEPTADO en el path de verify: la verificación computa sha1, así que
// un SignatureMethod/DigestMethod declarado distinto debe rechazarse explícitamente (no
// quedar como convención implícita) — un cambio futuro del motor no puede ampliarlo en
// silencio. Material tributario de terceros: la superficie de fraude no se relaja sola.
const ALLOWED_SIG_METHODS = new Set([SIG_ALGO]);
const ALLOWED_DIGEST_METHODS = new Set([DIGEST_ALGO]);

/**
 * Detecta declaraciones DTD/entidad en XML NO confiable (anti XXE / billion-laughs).
 * @xmldom no expande entidades externas por defecto, pero un DOCTYPE con entidades
 * internas habilita expansion-DoS. Un EnvioDTE/sobre SII legítimo JAMÁS trae DOCTYPE
 * ni ENTITY → rechazo total es seguro (fail-closed).
 */
export function hasDoctypeOrEntity(xml: string): boolean {
  return /<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml);
}

// deno-lint-ignore no-explicit-any
type DomNode = any;

/** Hijos ELEMENTO directos de `parent` con ese nombre (sin descender). Selección
 *  por estructura — defiende de firmas inyectadas en lo profundo del árbol (XSW). */
function directChildElements(parent: DomNode, name: string): DomNode[] {
  const out: DomNode[] = [];
  const kids = parent?.childNodes;
  if (!kids) return out;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (k.nodeType === 1 && (k.localName === name || k.nodeName === name)) out.push(k);
  }
  return out;
}

/** textContent (trim) del primer descendiente `tag` de `el`. */
function textOf(el: DomNode, tag: string): string {
  const v = el?.getElementsByTagName(tag)[0]?.textContent;
  return typeof v === "string" ? v.trim() : "";
}
/** Entero del primer descendiente `tag` (0 si falta/no numérico). */
function intOf(el: DomNode, tag: string): number {
  const n = parseInt(textOf(el, tag), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Vigencia del cert: notBefore ≤ now ≤ notAfter (A3b). */
function certWithinValidity(cert: forge.pki.Certificate, now: Date): boolean {
  const nb = cert.validity?.notBefore;
  const na = cert.validity?.notAfter;
  if (!(nb instanceof Date) || !(na instanceof Date)) return false;
  const t = now.getTime();
  return t >= nb.getTime() && t <= na.getTime();
}

/**
 * Núcleo reusable: verifica que `sigEl` (un <Signature>) firma VÁLIDAMENTE a
 * `referencedEl`, con la Reference apuntando a `expectedRefUri`. Hace las cuatro
 * comprobaciones (ninguna basta sola):
 *   (a) la Reference apunta EXACTAMENTE a expectedRefUri (no a otra cosa);
 *   (b) los Transforms están en la allowlist (no se manipula el digest);
 *   (c) BINDING: DigestValue == sha1(C14N(referencedEl)) — liga firma↔contenido;
 *   (d) vigencia del cert firmante + FIRMA RSA del SignedInfo (C14N en contexto).
 * Devuelve signerRut aun si ok=false (útil para logs/diagnóstico).
 */
function verifySignatureCovers(
  sigEl: DomNode,
  referencedEl: DomNode,
  expectedRefUri: string,
  now: Date,
  /** Ancestro donde cortar la herencia de namespaces (ver `canonicalize`). */
  boundary?: DomNode,
): { ok: boolean; signerRut: string | null } {
  const signedInfo = sigEl?.getElementsByTagName("SignedInfo")[0];
  if (!signedInfo) return { ok: false, signerRut: null };
  const ref = signedInfo.getElementsByTagName("Reference")[0];
  if (!ref) return { ok: false, signerRut: null };
  // (a) La Reference debe apuntar al elemento que creemos firmado.
  if ((ref.getAttribute("URI") ?? "") !== expectedRefUri) return { ok: false, signerRut: null };
  // (a2) Algoritmos pinneados al perfil SII (rsa-sha1 + sha1). La verificación computa
  // sha1; un SignatureMethod/DigestMethod declarado distinto se rechaza explícitamente.
  const sigMethod = signedInfo.getElementsByTagName("SignatureMethod")[0]?.getAttribute("Algorithm") ?? "";
  if (!ALLOWED_SIG_METHODS.has(sigMethod)) return { ok: false, signerRut: null };
  const digestMethod = ref.getElementsByTagName("DigestMethod")[0]?.getAttribute("Algorithm") ?? "";
  if (!ALLOWED_DIGEST_METHODS.has(digestMethod)) return { ok: false, signerRut: null };
  // (b) Transforms allowlist.
  const transforms = ref.getElementsByTagName("Transform");
  for (let i = 0; i < transforms.length; i++) {
    if (!ALLOWED_REF_TRANSFORMS.has(transforms[i].getAttribute("Algorithm") ?? "")) {
      return { ok: false, signerRut: null };
    }
  }
  // (c) Binding contenido↔firma.
  const digestValue = (signedInfo.getElementsByTagName("DigestValue")[0]?.textContent ?? "").replace(/\s+/g, "");
  if (!digestValue || digestValue !== sha1Base64(canonicalize(referencedEl, { boundary }))) {
    return { ok: false, signerRut: null };
  }
  // Cert + SignatureValue del MISMO <Signature> (no otro del documento).
  const certB64 = (sigEl.getElementsByTagName("X509Certificate")[0]?.textContent ?? "").replace(/\s+/g, "");
  const sigB64 = (sigEl.getElementsByTagName("SignatureValue")[0]?.textContent ?? "").replace(/\s+/g, "");
  if (!certB64 || !sigB64) return { ok: false, signerRut: null };
  let cert: forge.pki.Certificate;
  try {
    cert = forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.decode64(certB64)));
  } catch {
    return { ok: false, signerRut: null };
  }
  const signerRut = rutFromCertSubject(cert);
  // (d) Vigencia + firma RSA.
  if (!certWithinValidity(cert, now)) return { ok: false, signerRut };
  let ok = false;
  try {
    const md = forge.md.sha1.create();
    md.update(canonicalize(signedInfo, { boundary }), "utf8");
    ok = cert.publicKey.verify(md.digest().getBytes(), forge.util.decode64(sigB64));
  } catch {
    ok = false;
  }
  return { ok, signerRut };
}

/**
 * Elige, entre los <Signature> hijos DIRECTOS de `parent`, la que firma VÁLIDAMENTE
 * a `targetEl` (Reference URI="#targetId"). Si ninguna verifica, devuelve el primer
 * intento que apuntaba al target (para diagnóstico). Selección por ESTRUCTURA +
 * binding — robusta ante <Signature> inyectadas (NO "la última firma del sobre").
 *
 * `boundaries`: contextos de namespace a PROBAR, en orden (ver `canonicalize`). Los
 * dos son renderizados legítimos del MISMO contenido: firmar el subárbol aislado y
 * después meterlo en el sobre (lo normal en DTE) vs. firmarlo ya dentro del sobre
 * (lo normal en el SetDTE). Probar ambos no relaja nada: el digest y la firma RSA
 * tienen que calzar igual, solo se admite el eje de namespaces que usó el firmante.
 */
function verifyChildSignature(
  parent: DomNode,
  targetEl: DomNode,
  targetId: string,
  now: Date,
  boundaries: Array<DomNode | undefined> = [undefined],
): { ok: boolean; signerRut: string | null; sigEl: DomNode | null } {
  let chosen: { ok: boolean; signerRut: string | null; sigEl: DomNode } | null = null;
  for (const s of directChildElements(parent, "Signature")) {
    const r = s.getElementsByTagName("Reference")[0]?.getAttribute("URI") ?? "";
    if (r !== `#${targetId}`) continue;
    for (const boundary of boundaries) {
      const res = verifySignatureCovers(s, targetEl, `#${targetId}`, now, boundary);
      if (!chosen) chosen = { ...res, sigEl: s };
      if (res.ok) return { ...res, sigEl: s };
    }
  }
  return chosen ?? { ok: false, signerRut: null, sigEl: null };
}

/** Un <Documento> del EnvioDTE recibido: metadata (del DOM) + verdicto de SU firma. */
export type InboundDteVerified = {
  documentoId: string | null;
  tipoDte: number;
  folio: number;
  fchEmis: string;
  rutEmisor: string;
  rutRecep: string;
  mntTotal: number;
  /** `CorreoEmisor` del Encabezado (casilla de intercambio del emisor), si viene. */
  correoEmisor: string | null;
  /** La firma XMLDSig propia del <Documento> verifica (binding + RSA + cert vigente). */
  signatureOk: boolean;
  /** RUT del cert que firmó el DTE (en Chile = persona firmante, NO la empresa emisora). */
  signerRut: string | null;
};

/** Resultado de verificar un EnvioDTE recibido: firma del sobre + per-DTE + metadata. */
export type InboundEnvioVerification = {
  /** La firma del ENVELOPE (SetDTE) verifica (estructura + binding + RSA + vigencia). */
  envelopeOk: boolean;
  /** RUT del cert que firmó el sobre (= RutEnvia esperado). */
  signerRut: string | null;
  setId: string | null;
  rutEmisor: string;
  rutEnvia: string;
  rutReceptor: string;
  /** DigestValue del SetDTE (para el campo Digest del acuse). */
  digest: string | null;
  dtes: InboundDteVerified[];
};

/**
 * Verifica un EnvioDTE RECIBIDO de un tercero en UNA pasada del DOM (gate de A3 +
 * fuente de metadata para los acuses, M4). NUNCA firmar acuses Ley 19.983 (que hacen
 * el DTE cedible) sobre un envío/DTE cuya firma no se validó: ese es el vector de
 * fraude de factoring.
 *
 * Selección por ESTRUCTURA (no "la última firma", frágil ante inyección):
 *   - firma del sobre = <Signature> hijo DIRECTO del root, Reference URI="#<setId>";
 *   - firma per-DTE   = <Signature> hijo DIRECTO de cada <DTE>, URI="#<documentoId>".
 *
 * Sobre el binding firmante↔RUTEmisor per-DTE: en Chile el <Documento> lo firma el
 * cert de una PERSONA (RutFirma), distinto del RUTEmisor (empresa) — exigir igualdad
 * rechazaría DTEs legítimos (incl. los nuestros). El gate per-DTE es la VALIDEZ
 * CRIPTOGRÁFICA de la firma propia del Documento (integridad + cert vigente); el
 * signerRut se reporta para diagnóstico. El binding firmante↔remitente se aplica a
 * nivel de SOBRE (signerRut == RutEnvia) en el handler.
 */
export function verifyInboundEnvio(
  xml: string,
  opts: { now?: Date } = {},
): InboundEnvioVerification {
  const now = opts.now ?? new Date();
  const empty: InboundEnvioVerification = {
    envelopeOk: false,
    signerRut: null,
    setId: null,
    rutEmisor: "",
    rutEnvia: "",
    rutReceptor: "",
    digest: null,
    dtes: [],
  };
  // Seguridad (entrada NO confiable de terceros): rechazar DTD/entidades ANTES de
  // parsear. Un EnvioDTE legítimo nunca trae DOCTYPE/ENTITY → fail-closed = envelopeOk
  // false → el handler responde 422 sin firmar acuses sobre un payload hostil.
  if (hasDoctypeOrEntity(xml)) return empty;
  let doc: DomNode;
  try {
    doc = parseXml(xml);
  } catch {
    return empty;
  }
  const setDtes = doc.getElementsByTagName("SetDTE");
  if (!setDtes || setDtes.length === 0) return empty;
  const setDte = setDtes[0];
  const setId = setDte.getAttribute("ID");
  const envelopeEl = setDte.parentNode; // <EnvioDTE> / <EnvioBOLETA>

  // Carátula (M4: del DOM, no de un 2º pase regex desacoplado de lo verificado).
  const rutEmisor = textOf(setDte, "RutEmisor");
  const rutEnvia = textOf(setDte, "RutEnvia");
  const rutReceptor = textOf(setDte, "RutReceptor");

  // Per-DTE: metadata + verificación de la firma PROPIA de cada <Documento> (A3a).
  const dtes: InboundDteVerified[] = [];
  for (const dteEl of directChildElements(setDte, "DTE")) {
    const documento = dteEl.getElementsByTagName("Documento")[0];
    if (!documento) continue;
    const documentoId = documento.getAttribute("ID");
    // El emisor firma el <DTE> AISLADO y recién después lo mete en el sobre → se prueba
    // primero ese eje de namespaces (boundary=dteEl) y después el in-envelope.
    const sigRes = documentoId
      ? verifyChildSignature(dteEl, documento, documentoId, now, [dteEl, undefined])
      : { ok: false, signerRut: null };
    dtes.push({
      documentoId: documentoId ?? null,
      tipoDte: intOf(documento, "TipoDTE"),
      folio: intOf(documento, "Folio"),
      fchEmis: textOf(documento, "FchEmis"),
      rutEmisor: textOf(documento, "RUTEmisor") || rutEmisor,
      rutRecep: textOf(documento, "RUTRecep") || rutReceptor,
      mntTotal: intOf(documento, "MntTotal"),
      // Casilla de intercambio DECLARADA DENTRO del documento firmado: es el destino
      // confiable del acuse (no se puede alterar sin romper la firma per-DTE).
      correoEmisor: textOf(documento, "CorreoEmisor") || null,
      signatureOk: sigRes.ok,
      signerRut: sigRes.signerRut,
    });
  }

  // Firma del ENVELOPE: <Signature> hijo DIRECTO del root con Reference URI="#setId".
  let envelopeOk = false;
  let signerRut: string | null = null;
  let digest: string | null = null;
  if (setId && envelopeEl) {
    const env = verifyChildSignature(envelopeEl, setDte, setId, now);
    envelopeOk = env.ok;
    signerRut = env.signerRut;
    if (env.sigEl) {
      digest = (env.sigEl.getElementsByTagName("DigestValue")[0]?.textContent ?? "").replace(/\s+/g, "") || null;
    }
  }

  return { envelopeOk, signerRut, setId: setId ?? null, rutEmisor, rutEnvia, rutReceptor, digest, dtes };
}

/**
 * Compat: valida solo la firma del ENVELOPE (delegando en verifyInboundEnvio).
 * Para el gate completo (per-DTE incluido) usar verifyInboundEnvio.
 */
export function verifyInboundEnvioSignature(
  xml: string,
  opts: { now?: Date } = {},
): { ok: boolean; signerRut: string | null } {
  const v = verifyInboundEnvio(xml, opts);
  return { ok: v.envelopeOk, signerRut: v.signerRut };
}

// ---------- Entrada pública: firma desde .pfx -------------------------------

/**
 * Entrada de `signSiiXml`: qué elemento firmar y con qué .pfx.
 *
 * `signedElementId` se copia tal cual al `URI="#…"` de la Reference y nadie comprueba que ese ID
 * exista en el documento: si no calza con el atributo `ID` del elemento, la firma queda apuntando a
 * nada. `signedElementNs` e `injectNs` no alteran el resultado en la implementación actual — el digest
 * se calcula sobre la C14N del elemento en su contexto, que ya trae los namespaces heredados del root.
 */
export type SignSiiXmlOptions = {
  /** XML sin firma (compacto). */
  xml: string;
  /** Tag del elemento firmado, ej. "DocumentoConsumoFolios". */
  signedElementTag: string;
  /** Valor del atributo ID del elemento firmado. */
  signedElementId: string;
  /** Namespace heredado del root, ej. "http://www.sii.cl/SiiDte". Ignorado si injectNs=false. */
  signedElementNs: string;
  /** Bytes del .pfx (PKCS#12). */
  pfxBytes: Uint8Array;
  /** Password del .pfx. */
  password: string;
  /** Transform de la Reference. Default "enveloped" (RCOF). Boleta DTE = "c14n". */
  transform?: RefTransform;
  /** Inyectar el namespace heredado en el digest. Default true. DTE (sin xmlns) = false. */
  injectNs?: boolean;
};

/**
 * Firma un XML SII desde un .pfx. Extrae cert+key con node-forge (reusa
 * `extractPemFromPkcs12`) y delega en `signXmlWithForgeKey`.
 *
 * El RUT del certificado firmante debe coincidir con `RutEnvia` del documento
 * (regla SII; si no, "RUT no autorizado a firmar").
 */
export function signSiiXml(opts: SignSiiXmlOptions): string {
  const { certPem, pkeyPem } = extractPemFromPkcs12(opts.pfxBytes, opts.password);
  const privateKey = forge.pki.privateKeyFromPem(pkeyPem);
  const certificate = forge.pki.certificateFromPem(certPem);
  return signXmlWithForgeKey(
    opts.xml,
    opts.signedElementTag,
    opts.signedElementId,
    opts.signedElementNs,
    { privateKey, certificate },
    { transform: opts.transform, injectNs: opts.injectNs },
  );
}

/**
 * Conveniencia: firma un `<ConsumoFolios>` (RCOF) generado por consumo-folios.ts.
 */
export function signConsumoFolios(
  unsignedXml: string,
  documentId: string,
  pfxBytes: Uint8Array,
  password: string,
): string {
  return signSiiXml({
    xml: unsignedXml,
    signedElementTag: "DocumentoConsumoFolios",
    signedElementId: documentId,
    signedElementNs: "http://www.sii.cl/SiiDte",
    pfxBytes,
    password,
  });
}

/**
 * Firma el `<Documento>` de una boleta DTE y lo envuelve en `<DTE>`, en la
 * FORMA EMITIDA que el SII acepta (calibrada byte-a-byte contra el sobre real
 * del oráculo de calibración, SII-aceptado, 2026-06-10):
 *
 *   <DTE version="1.0">\r\n
 *   <Documento ID="…">  ← PRETTY: CRLF en cada frontera de tags (`>` → `>\r\n<`)
 *   …
 *   </Documento>\r\n
 *   <Signature xmlns="…">…COMPACTA…</Signature></DTE>
 *                          ↑ X509Certificate con su base64 envuelto a 76 cols
 *
 * Reglas duras del validador SII (observadas vivas en Maullín):
 *   - líneas >4096 chars → rechazo "CHR-00002: Line too long" (por eso pretty
 *     + base64 del X509 envuelto);
 *   - whitespace entre hijos de <Signature> → "LPX-00007: unexpected EOF"
 *     (por eso la Signature va COMPACTA, como el oráculo).
 *
 * El digest de la Reference se computa sobre la forma C14N del Documento pretty.
 * Como el builder no emite elementos vacíos, los atributos van normalizados y el
 * `<DTE>` no declara xmlns, C14N(pretty) = pretty con CRLF→LF — misma identidad
 * validada en c14n.test.ts (reproduce el DigestValue real del oráculo de calibración sobre su
 * Documento pretty). La firma del SignedInfo es RSA-SHA1 estándar.
 *
 * Devuelve el DTE como string Unicode con la declaración iso-8859-1; los BYTES de
 * transmisión se obtienen con `encodeLatin1` (el digest XMLDSig va sobre UTF-8 —
 * C14N estándar — aunque el documento se serialice en iso-8859-1).
 */
export function signBoletaDte(
  documentoXml: string,
  documentId: string,
  pfxBytes: Uint8Array,
  password: string,
): string {
  const { certPem, pkeyPem } = extractPemFromPkcs12(pfxBytes, password);
  const privateKey = forge.pki.privateKeyFromPem(pkeyPem);
  const certificate = forge.pki.certificateFromPem(certPem);

  // 1. Forma emitida del Documento: pretty CRLF en cada frontera de tags. El
  //    escaping de texto/atributos garantiza que no hay `><` dentro de valores.
  const pretty = documentoXml.replace(/></g, ">\r\n<");

  // 2. Digest = SHA1(utf8(C14N REAL del Documento)). Para el Documento actual
  //    (sin elementos vacíos) coincide con el atajo pretty-CRLF→LF (verificado:
  //    reproduce el DigestValue del oráculo de calibración), pero el C14N real además cubre
  //    futuros tags vacíos (ej. <DscItem/>).
  const digestValueBase64 = sha1Base64(canonicalize(parseXml(pretty).documentElement));

  // 3. SignedInfo → C14N REAL → firma RSA-SHA1. ⚠️ NO firmar el string crudo:
  //    los tags autocerrados del SignedInfo (<CanonicalizationMethod/>, etc.) se
  //    expanden en C14N (<X/> → <X></X>); firmar la forma self-closing producía
  //    "505 Firma DTE Incorrecta" en TODOS los DTE (verificado VIVO 2026-06-12,
  //    track 28074483 — la firma del SET, que usa C14N real, pasó FOK).
  const signedInfoInner = buildSignedInfoInner(documentId, digestValueBase64, "c14n");
  const canonicalSignedInfo = canonicalize(
    parseXml(injectInheritedNamespace(signedInfoInner, "SignedInfo", DSIG_NS)).documentElement,
  );
  const md = forge.md.sha1.create();
  md.update(canonicalSignedInfo, "utf8");
  const signatureValueBase64 = forge.util.encode64(privateKey.sign(md));

  // 4. KeyInfo: modulus/exponent sin envolver (~344 chars); X509 envuelto a 76.
  const pub = certificate.publicKey;
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes();
  const signature = buildSignatureElement({
    signedElementId: documentId,
    digestValueBase64,
    signatureValueBase64,
    modulusBase64: bigIntToBase64(pub.n),
    exponentBase64: bigIntToBase64(pub.e),
    x509Base64: wrapBase64Lines(forge.util.encode64(certDer)),
  }, "c14n");

  return `<?xml version="1.0" encoding="iso-8859-1"?>` +
    `<DTE version="1.0">\r\n` + pretty + `\r\n` + signature + `</DTE>`;
}

/**
 * Alias genérico de `signBoletaDte`: firma CUALQUIER `<Documento>` (factura, NC,
 * ND, guía, FC) y lo envuelve en `<DTE>`. La firma per-DTE es idéntica para toda
 * la familia (Reference c14n, KeyInfo, forma emitida pretty + Signature compacta;
 * verificado vs el oráculo F60T33). El nombre `signBoletaDte` se conserva por los
 * callers históricos de boleta; el motor de factura usa este nombre neutral.
 */
export const signDte = signBoletaDte;

/**
 * Serializa un string XML a bytes iso-8859-1 (Latin-1) para transmisión/firma de
 * sobre. Falla si hay caracteres fuera de Latin-1 (el SII no los admite en DTE).
 */
export function encodeLatin1(xml: string): Uint8Array {
  const bytes = new Uint8Array(xml.length);
  for (let i = 0; i < xml.length; i++) {
    const code = xml.charCodeAt(i);
    if (code > 0xff) {
      throw new Error(
        `encodeLatin1: carácter fuera de iso-8859-1 en pos ${i}: U+${code.toString(16)}`,
      );
    }
    bytes[i] = code;
  }
  return bytes;
}
