// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Canonical XML 1.0 inclusivo (variante sin comentarios): la serialización exacta sobre la que se
 * calculan los DigestValue y las firmas XMLDSig de un DTE.
 *
 * Está construido sobre DOM y no sobre strings a propósito: un sobre mezcla el default `SiiDte`, el
 * `xsi` heredado del root y el `xmldsig#` de cada `<Signature>` anidada, y compactar strings reproduce
 * el digest de un solo namespace, no el eje inclusivo. Propaga al ápice los namespaces en-scope, borra
 * los superfluos, expande los elementos vacíos y descarta comentarios y PI; la normalización de fines
 * de línea la hace `parseXml`, no `canonicalize` — si traes tu propio DOM, ese paso no corrió. El digest
 * XMLDSig es SHA-1 sobre los BYTES UTF-8 de lo que devuelve, aunque el DTE viaje en iso-8859-1; firmar
 * y verificar viven en `@ruraldte/engine/firma`.
 *
 * @example
 * ```ts
 * import { canonicalize, canonicalizeElement, parseXml } from "@ruraldte/engine/c14n";
 *
 * // DTE suelto: la forma canónica del <Documento> es lo que se hashea para el DigestValue.
 * const canonico = canonicalizeElement(await Deno.readTextFile("dte.xml"), "Documento", "F100T33");
 *
 * // Dentro de un sobre hay que cortar la herencia de namespaces en el <DTE> con `boundary`: el
 * // emisor firmó cada documento AISLADO, así que los prefijos extra del sobre no van al ápice.
 * const doc = parseXml(await Deno.readTextFile("envio-dte.xml"));
 * const dte = doc.getElementsByTagName("DTE")[0];
 * const aislado = canonicalize(dte.getElementsByTagName("Documento")[0], { boundary: dte });
 * ```
 *
 * @module
 */
// ============================================================================
// c14n.ts — Canonical XML 1.0 *inclusive* (http://www.w3.org/TR/2001/REC-xml-c14n-20010315),
//           variante "sin comentarios". Implementación parser-based (DOM).
// ============================================================================
//
// Por qué parser-based y no string-replace: la firma del `<SetDTE>` del sobre
// EnvioBOLETA mezcla namespaces (default `SiiDte` del sobre + `xsi` heredado del
// root + `xmldsig#` en cada `<Signature>` anidada). El "atajo" de compactar/
// inyectar strings reproduce el digest de un solo namespace (RCOF, DTE per-doc)
// pero NO el eje de namespaces inclusivo que exige el SetDTE. Esta C14N real:
//   - normaliza fines de línea (#xD#xA y #xD → #xA) ANTES de parsear,
//   - expande elementos vacíos (`<X/>` → `<X></X>`),
//   - propaga al ápice TODOS los namespaces en-scope heredados de ancestros que
//     NO están en el node-set (regla inclusiva — acá entra el `xsi`),
//   - emite un namespace en un descendiente sólo si difiere del ya renderizado
//     por un ancestro de salida (eliminación de namespaces superfluos),
//   - ordena: nodos namespace (default primero, luego por prefijo) ANTES de los
//     atributos; atributos por (namespaceURI, localName),
//   - escapa texto/atributos según el espec.
//
// VALIDADA contra datos cripto REALES aceptados por el SII (ver c14n.test.ts):
//   1) reproduce el DigestValue per-DTE del Documento (oráculo de calibración),
//   2) la SignatureValue per-DTE verifica RSA sobre C14N(SignedInfo) [standalone],
//   3) la SignatureValue del SET verifica RSA sobre C14N(SignedInfo) [in-envelope,
//      con `xsi` heredado] — el caso de namespaces mixtos.
//
// NOTA encoding: esta función trabaja sobre strings Unicode y produce el string
// canónico. El digest XMLDSig es SHA1 sobre los BYTES UTF-8 de ese string (C14N
// estándar), aunque el DTE se TRANSMITA en iso-8859-1 (ver encodeLatin1).
// ============================================================================

import { DOMParser } from "npm:@xmldom/xmldom@0.9.10";

const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

/**
 * Nodo del DOM que circula por este módulo: el `Document` que devuelve `parseXml`, un `Element`, un
 * `Attr` o cualquier hijo del árbol. Es un alias de `any` a propósito —el DOM lo aporta
 * `@xmldom/xmldom` y acá no hay chequeo de tipos—, así que si traes tu propio DOM tiene que exponer
 * todo lo que este módulo recorre a mano: `nodeType`, `nodeName`, `namespaceURI`, `localName`,
 * `name`, `value`, `data`/`nodeValue`, `parentNode`, y `attributes`/`childNodes` indexables con
 * `length`; `canonicalizeElement` además usa `getElementsByTagName` y `getAttribute`.
 */
// deno-lint-ignore no-explicit-any
type XmlNode = any;
/** prefix ("" = default) -> namespace URI */
type NsMap = Map<string, string>;

/** Normaliza fines de línea según C14N y parsea a DOM. */
export function parseXml(xml: string): XmlNode {
  const normalized = xml.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return new DOMParser().parseFromString(normalized, "text/xml");
}

function isNsDecl(attr: XmlNode): boolean {
  return attr.namespaceURI === XMLNS_NS || attr.name === "xmlns" ||
    (typeof attr.name === "string" && attr.name.startsWith("xmlns:"));
}
function nsPrefixOf(attr: XmlNode): string {
  return attr.name === "xmlns" ? "" : attr.name.slice("xmlns:".length);
}

/**
 * Namespaces en-scope sobre `el` (self + ancestros; el más cercano gana).
 * `boundary`: si se pasa, la subida PARA en ese elemento (inclusive) — es decir,
 * los ancestros POR ENCIMA del boundary no aportan namespaces. Modela "canonicalizar
 * este subárbol como si fuera un documento aislado" (ver `canonicalize`).
 */
function collectInScope(el: XmlNode, boundary?: XmlNode): NsMap {
  const map: NsMap = new Map();
  let n: XmlNode = el;
  while (n && n.nodeType === 1) {
    const attrs = n.attributes;
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      if (isNsDecl(a)) {
        const p = nsPrefixOf(a);
        if (!map.has(p)) map.set(p, a.value);
      }
    }
    if (boundary && n === boundary) break;
    n = n.parentNode;
  }
  return map;
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\r/g, "&#xD;");
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
    .replace(/\t/g, "&#x9;").replace(/\n/g, "&#xA;").replace(/\r/g, "&#xD;");
}

function c14nElement(el: XmlNode, rendered: NsMap, boundary?: XmlNode): string {
  // 1) namespaces a emitir = en-scope que difieren de lo ya renderizado por ancestros.
  const inScope = collectInScope(el, boundary);
  const childRendered: NsMap = new Map(rendered);
  const nsToEmit: { decl: string; key: string }[] = [];
  for (const [prefix, uri] of inScope) {
    if (rendered.get(prefix) === uri) continue; // superfluo
    // default vacío sólo se emite si "deshace" un default no-vacío del ancestro.
    if (prefix === "" && uri === "" && !(rendered.get("") && rendered.get("") !== "")) continue;
    const decl = prefix === ""
      ? `xmlns="${escapeAttr(uri)}"`
      : `xmlns:${prefix}="${escapeAttr(uri)}"`;
    nsToEmit.push({ decl, key: prefix });
    childRendered.set(prefix, uri);
  }
  // orden: default ("") primero, luego por prefijo ascendente.
  nsToEmit.sort((a, b) => (a.key === b.key ? 0 : a.key < b.key ? -1 : 1));

  // 2) atributos normales por (namespaceURI, localName); sin-namespace primero.
  const attrs = el.attributes;
  const ordered: { name: string; value: string; uri: string; local: string }[] = [];
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i];
    if (isNsDecl(a)) continue;
    ordered.push({
      name: a.name,
      value: a.value,
      uri: a.namespaceURI || "",
      local: a.localName || a.name,
    });
  }
  ordered.sort((a, b) =>
    a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : a.local < b.local ? -1 : a.local > b.local ? 1 : 0
  );

  let out = `<${el.nodeName}`;
  for (const n of nsToEmit) out += " " + n.decl;
  for (const a of ordered) out += ` ${a.name}="${escapeAttr(a.value)}"`;
  out += ">";
  const kids = el.childNodes;
  for (let i = 0; i < kids.length; i++) out += c14nNode(kids[i], childRendered, boundary);
  out += `</${el.nodeName}>`;
  return out;
}

function c14nNode(node: XmlNode, rendered: NsMap, boundary?: XmlNode): string {
  switch (node.nodeType) {
    case 1: // element
      return c14nElement(node, rendered, boundary);
    case 3: // text
    case 4: // CDATA → texto
      return escapeText(node.data ?? node.nodeValue ?? "");
    default: // comentarios (8) / PI (7): omitidos en la variante "sin comentarios"
      return "";
  }
}

/**
 * Canonicaliza un elemento (en el contexto de su documento, heredando los
 * namespaces de sus ancestros — semántica de "sub-árbol de un documento mayor",
 * que es como el SII deref-erencia `Reference URI="#id"`).
 *
 * `opts.boundary`: corta la herencia de namespaces en ese ancestro (inclusive),
 * como si el subárbol fuera un documento aparte. Necesario para VERIFICAR la firma
 * per-DTE de un EnvioDTE recibido: el emisor firma cada `<DTE>` AISLADO y recién
 * después lo mete en el sobre. Si el sobre declara prefijos extra (`xmlns:dsig`,
 * `xmlns:envio`, …), la C14N inclusiva se los inyectaría al ápice `<Documento>` y
 * el digest no calzaría — aunque la firma sea perfectamente válida. Sin `boundary`
 * el comportamiento es IDÉNTICO al de siempre (todos los caminos de FIRMA lo usan así).
 */
export function canonicalize(el: XmlNode, opts: { boundary?: XmlNode } = {}): string {
  return c14nElement(el, new Map(), opts.boundary);
}

/**
 * Conveniencia: parsea `xml`, ubica el primer elemento `tag` (opcionalmente con
 * un atributo `ID` dado) y devuelve su forma canónica.
 */
export function canonicalizeElement(
  xml: string,
  tag: string,
  id?: string,
): string {
  const doc = parseXml(xml);
  const els = doc.getElementsByTagName(tag);
  for (let i = 0; i < els.length; i++) {
    if (id === undefined || els[i].getAttribute("ID") === id) {
      return canonicalize(els[i]);
    }
  }
  throw new Error(`canonicalizeElement: <${tag}${id ? ` ID="${id}"` : ""}> no encontrado`);
}
