// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

import { assert, assertEquals } from "jsr:@std/assert@1";
import forge from "npm:node-forge@1.3.1";
import { canonicalize, parseXml } from "./c14n.ts";
import { buildConsumoFoliosXml, type ConsumoFoliosCaratula } from "./consumo-folios.ts";
import {
  extractElement,
  hasDoctypeOrEntity,
  injectInheritedNamespace,
  sha1Base64,
  signXmlWithForgeKey,
  verifyForgeSignature,
  verifyInboundEnvio,
  verifyInboundEnvioSignature,
} from "./xml-signature.ts";

const SII_NS = "http://www.sii.cl/SiiDte";

Deno.test("sha1Base64: known answer vector", () => {
  // SHA1("abc") = a9993e36...  → base64
  assertEquals(sha1Base64("abc"), "qZk+NkcGgWq6PiVxeFDCbJzQ2J0=");
});

Deno.test("injectInheritedNamespace: inserta xmlns antes de los atributos, idempotente", () => {
  const sub = '<DocumentoConsumoFolios ID="X1"><Caratula>a</Caratula></DocumentoConsumoFolios>';
  const out = injectInheritedNamespace(sub, "DocumentoConsumoFolios", SII_NS);
  assertEquals(
    out,
    '<DocumentoConsumoFolios xmlns="http://www.sii.cl/SiiDte" ID="X1"><Caratula>a</Caratula></DocumentoConsumoFolios>',
  );
  // idempotente si ya tiene xmlns
  assertEquals(injectInheritedNamespace(out, "DocumentoConsumoFolios", SII_NS), out);
});

Deno.test("extractElement: extrae el sub-árbol exacto", () => {
  const xml = '<Root><A><B>1</B></A><C>2</C></Root>';
  assertEquals(extractElement(xml, "A"), "<A><B>1</B></A>");
});

function makeTestKeyAndCert(
  opts: { rut?: string; notBefore?: Date; notAfter?: Date } = {},
) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  const nb = opts.notBefore ?? new Date();
  cert.validity.notBefore = nb;
  if (opts.notAfter) {
    cert.validity.notAfter = opts.notAfter;
  } else {
    const na = new Date(nb);
    na.setFullYear(nb.getFullYear() + 1);
    cert.validity.notAfter = na;
  }
  const attrs = [
    { name: "commonName", value: "TEST CERT" },
    { name: "serialNumber", value: opts.rut ?? "22222222-2" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { keys, cert };
}

// EnvioDTE entrante (sin firmar) con Encabezado completo → la verificación extrae
// metadata real del DOM. Los tests firman el Documento y/o el SetDTE según el caso.
function envelopeXml(
  o: { setId?: string; documentoId?: string; rutEmisor?: string; rutEnvia?: string; rutReceptor?: string } = {},
): string {
  const setId = o.setId ?? "SetDoc";
  const documentoId = o.documentoId ?? "F100T33";
  const rutEmisor = o.rutEmisor ?? "77777777-7";
  const rutEnvia = o.rutEnvia ?? "11111111-1";
  const rutReceptor = o.rutReceptor ?? "78416626-0";
  return `<EnvioDTE xmlns="${SII_NS}"><SetDTE ID="${setId}">` +
    `<Caratula><RutEmisor>${rutEmisor}</RutEmisor><RutEnvia>${rutEnvia}</RutEnvia><RutReceptor>${rutReceptor}</RutReceptor></Caratula>` +
    `<DTE><Documento ID="${documentoId}"><Encabezado>` +
    `<IdDoc><TipoDTE>33</TipoDTE><Folio>100</Folio><FchEmis>2026-06-20</FchEmis></IdDoc>` +
    `<Emisor><RUTEmisor>${rutEmisor}</RUTEmisor></Emisor>` +
    `<Receptor><RUTRecep>${rutReceptor}</RUTRecep></Receptor>` +
    `<Totales><MntTotal>119000</MntTotal></Totales>` +
    `</Encabezado></Documento></DTE></SetDTE></EnvioDTE>`;
}

function forgeKey(rut: string, validity?: { notBefore: Date; notAfter: Date }) {
  const { keys, cert } = makeTestKeyAndCert({ rut, ...validity });
  return { privateKey: keys.privateKey, certificate: cert };
}

const CARATULA: ConsumoFoliosCaratula = {
  rutEmisor: "78416626-0",
  rutEnvia: "22222222-2",
  fchResol: "2026-06-06",
  nroResol: 0,
  fchInicio: "2026-06-06",
  fchFinal: "2026-06-06",
  secEnvio: 1,
  tmstFirmaEnv: "2026-06-06T12:00:00",
};

Deno.test("verifyInboundEnvioSignature: envelope firmado válido → ok + RUT; tamper → inválido (A3)", () => {
  const { keys, cert } = makeTestKeyAndCert();
  const unsigned =
    `<EnvioDTE xmlns="${SII_NS}"><SetDTE ID="SetDoc">` +
    `<Caratula><RutEmisor>78416626-0</RutEmisor><RutEnvia>22222222-2</RutEnvia></Caratula>` +
    `<DTE><Documento ID="F1T33"><Encabezado>ok</Encabezado></Documento></DTE>` +
    `</SetDTE></EnvioDTE>`;
  // Firma el SetDTE (enveloped) → Signature sibling, como el EnvioDTE real.
  const signed = signXmlWithForgeKey(unsigned, "SetDTE", "SetDoc", SII_NS, {
    privateKey: keys.privateKey,
    certificate: cert,
  });

  const r = verifyInboundEnvioSignature(signed);
  assert(r.ok, "la firma del envelope válido debe verificar");
  assertEquals(r.signerRut, "22222222-2", "extrae el RUT del cert firmante (subject serialNumber)");

  // Tamper del contenido firmado (dentro del SetDTE): el binding DigestValue↔SetDTE lo atrapa.
  const tampered = signed.replace("78416626-0", "11111111-1");
  assert(!verifyInboundEnvioSignature(tampered).ok, "alterar el SetDTE firmado invalida la firma");

  // Sin firma → inválido (no se acusa un envío sin firma).
  assert(
    !verifyInboundEnvioSignature(`<EnvioDTE xmlns="${SII_NS}"><SetDTE ID="x"><Caratula/></SetDTE></EnvioDTE>`).ok,
    "sin firma → inválido",
  );
});

Deno.test("signXmlWithForgeKey: firma enveloped, estructura y roundtrip de verificación", () => {
  const { keys, cert } = makeTestKeyAndCert();
  const { xml, documentId } = buildConsumoFoliosXml({
    caratula: CARATULA,
    resumenes: [{
      tipoDocumento: 39,
      mntNeto: 3000,
      mntIva: 570,
      tasaIva: 19,
      mntTotal: 3570,
      foliosEmitidos: 3,
      foliosAnulados: 0,
      foliosUtilizados: 3,
      rangoUtilizados: [{ inicial: 1, final: 3 }],
    }],
  });

  const signed = signXmlWithForgeKey(
    xml,
    "DocumentoConsumoFolios",
    documentId,
    SII_NS,
    { privateKey: keys.privateKey, certificate: cert },
  );

  // Estructura de la firma
  assert(signed.includes('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">'));
  assert(signed.includes("<DigestValue>"));
  assert(signed.includes("<SignatureValue>"));
  assert(signed.includes("<X509Certificate>"));
  assert(signed.includes(`<Reference URI="#${documentId}">`));

  // La firma es hermana de DocumentoConsumoFolios (después de cerrarlo, antes del root)
  assert(signed.indexOf("</DocumentoConsumoFolios>") < signed.indexOf("<Signature"));
  assert(signed.indexOf("<Signature") < signed.indexOf("</ConsumoFolios>"));

  // DigestValue = C14N REAL del elemento EN SU CONTEXTO (la C14N inclusiva emite
  // los ns heredados del root — xmlns SiiDte + xmlns:xsi del schemaLocation).
  const expectedDigest = sha1Base64(
    canonicalize(parseXml(signed).getElementsByTagName("DocumentoConsumoFolios")[0]),
  );
  const digestInDoc = signed.match(/<DigestValue>([^<]+)<\/DigestValue>/)![1];
  assertEquals(digestInDoc, expectedDigest);

  // Roundtrip: la firma valida contra la clave pública
  assert(verifyForgeSignature(signed, keys.publicKey));
});

Deno.test("verifyForgeSignature: detecta SignatureValue adulterada", () => {
  const { keys, cert } = makeTestKeyAndCert();
  const { xml, documentId } = buildConsumoFoliosXml({
    caratula: CARATULA,
    resumenes: [{
      tipoDocumento: 41,
      mntExento: 5000,
      mntTotal: 5000,
      foliosEmitidos: 1,
      foliosAnulados: 0,
      foliosUtilizados: 1,
      rangoUtilizados: [{ inicial: 7, final: 7 }],
    }],
  });
  const signed = signXmlWithForgeKey(
    xml,
    "DocumentoConsumoFolios",
    documentId,
    SII_NS,
    { privateKey: keys.privateKey, certificate: cert },
  );

  // Flip del primer carácter de la SignatureValue (sigue siendo base64 válido)
  const tampered = signed.replace(
    /<SignatureValue>(.)/,
    (_m, c) => `<SignatureValue>${c === "A" ? "B" : "A"}`,
  );
  assertEquals(verifyForgeSignature(tampered, keys.publicKey), false);
});

Deno.test("verifyInboundEnvio: firma per-DTE válida → signatureOk + signerRut + metadata (A3a/M4)", () => {
  const signed = signXmlWithForgeKey(envelopeXml(), "Documento", "F100T33", SII_NS, forgeKey("22222222-2"));
  const v = verifyInboundEnvio(signed);
  assertEquals(v.dtes.length, 1);
  assert(v.dtes[0].signatureOk, "la firma per-DTE válida debe verificar");
  assertEquals(v.dtes[0].signerRut, "22222222-2");
  // Metadata derivada del DOM verificado (M4).
  assertEquals(v.dtes[0].tipoDte, 33);
  assertEquals(v.dtes[0].folio, 100);
  assertEquals(v.dtes[0].rutEmisor, "77777777-7");
  assertEquals(v.dtes[0].mntTotal, 119000);
  assertEquals(v.rutReceptor, "78416626-0");
  // Tamper del Documento firmado → su firma cae (binding DigestValue↔Documento).
  assert(!verifyInboundEnvio(signed.replace("119000", "999999")).dtes[0].signatureOk);
});

Deno.test("verifyInboundEnvio: sobre firmado, DTE sin firma propia → envelopeOk pero signatureOk=false (gate A3a)", () => {
  const signed = signXmlWithForgeKey(envelopeXml(), "SetDTE", "SetDoc", SII_NS, forgeKey("11111111-1"));
  const v = verifyInboundEnvio(signed);
  assert(v.envelopeOk, "la firma del sobre verifica");
  assertEquals(v.signerRut, "11111111-1");
  assertEquals(v.dtes[0].signatureOk, false, "un DTE sin firma propia NO se acredita para EnvioRecibos");
});

Deno.test("verifyInboundEnvio: cert firmante vencido → rechazado salvo dentro de su vigencia (A3b)", () => {
  const key = forgeKey("11111111-1", {
    notBefore: new Date("2020-01-01T00:00:00Z"),
    notAfter: new Date("2021-01-01T00:00:00Z"),
  });
  const signed = signXmlWithForgeKey(envelopeXml(), "SetDTE", "SetDoc", SII_NS, key);
  assert(!verifyInboundEnvio(signed).envelopeOk, "vencido respecto de now → rechazado");
  assert(
    verifyInboundEnvio(signed, { now: new Date("2020-06-01T00:00:00Z") }).envelopeOk,
    "dentro de la vigencia → verifica (aísla el gate de vigencia)",
  );
});

Deno.test("verifyInboundEnvio: Transform fuera de la allowlist en la Reference → rechazado (A3c)", () => {
  const signed = signXmlWithForgeKey(envelopeXml(), "SetDTE", "SetDoc", SII_NS, forgeKey("11111111-1"));
  assert(verifyInboundEnvio(signed).envelopeOk, "sanity: válido antes del tamper");
  const withXpath = signed.replace(
    '<Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></Transforms>',
    '<Transforms><Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"/></Transforms>',
  );
  assert(!verifyInboundEnvio(withXpath).envelopeOk, "un Transform no permitido invalida la firma");
});

Deno.test("verifyInboundEnvio: <Signature> inyectada no rompe la selección estructural (A3c)", () => {
  const signed = signXmlWithForgeKey(envelopeXml(), "SetDTE", "SetDoc", SII_NS, forgeKey("11111111-1"));
  const decoy = `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo>` +
    `<Reference URI="#SetDoc"><DigestValue>AAAA</DigestValue></Reference></SignedInfo>` +
    `<SignatureValue>AAAA</SignatureValue><KeyInfo><X509Data><X509Certificate>AAAA</X509Certificate></X509Data></KeyInfo></Signature>`;
  // Decoy ANTES de la firma real (ambas hijas directas del root, Reference #SetDoc).
  const withDecoy = signed.replace("</SetDTE>", "</SetDTE>" + decoy);
  assert(verifyInboundEnvio(withDecoy).envelopeOk, "elige la firma VÁLIDA, no 'la primera/última'");
  // Decoy SOLO (sin la firma real) → no valida el sobre.
  const onlyDecoy = envelopeXml().replace("</SetDTE>", "</SetDTE>" + decoy);
  assert(!verifyInboundEnvio(onlyDecoy).envelopeOk, "una firma inyectada sola no valida el sobre");
});

Deno.test("verifyInboundEnvio: DTE firmado AISLADO + sobre con prefijos extra → signatureOk (caso real de un proveedor externo)", () => {
  // Así emiten los proveedores reales: se firma cada <DTE> como documento APARTE
  // (sin ningún xmlns heredado) y recién después se mete en un sobre que declara sus
  // propios prefijos (xmlns:envio, xmlns:dsig, xmlns:xsi). Canonicalizar el
  // <Documento> con los ns del sobre daba OTRO digest → signatureOk=false para
  // documentos perfectamente válidos, y con eso NUNCA se emitía el EnvioRecibos
  // (Ley 19.983). Regresión de la 1ª factura entrante real (Flow S.A., 2026-07-31).
  const dteAislado = `<DTE version="1.0"><Documento ID="F100T33"><Encabezado>` +
    `<IdDoc><TipoDTE>33</TipoDTE><Folio>100</Folio><FchEmis>2026-07-31</FchEmis></IdDoc>` +
    `<Emisor><RUTEmisor>76543210-3</RUTEmisor><CorreoEmisor>dte@proveedor.cl</CorreoEmisor></Emisor>` +
    `<Receptor><RUTRecep>78416626-0</RUTRecep></Receptor>` +
    `<Totales><MntTotal>6001</MntTotal></Totales>` +
    `</Encabezado></Documento></DTE>`;
  const dteFirmado = signXmlWithForgeKey(dteAislado, "Documento", "F100T33", "", forgeKey("44444444-4"), {
    transform: "c14n",
  });
  const sobre = `<EnvioDTE xmlns:envio="${SII_NS}" xmlns:dsig="http://www.w3.org/2000/09/xmldsig#" ` +
    `xmlns="${SII_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><SetDTE ID="SetDoc">` +
    `<Caratula><RutEmisor>76543210-3</RutEmisor><RutEnvia>44444444-4</RutEnvia>` +
    `<RutReceptor>78416626-0</RutReceptor></Caratula>` +
    dteFirmado +
    `</SetDTE></EnvioDTE>`;

  const v = verifyInboundEnvio(sobre);
  assertEquals(v.dtes.length, 1);
  assert(v.dtes[0].signatureOk, "el DTE firmado aislado debe verificar dentro de un sobre con prefijos extra");
  assertEquals(v.dtes[0].signerRut, "44444444-4");
  // La casilla del emisor sale del documento FIRMADO → destino confiable del acuse.
  assertEquals(v.dtes[0].correoEmisor, "dte@proveedor.cl");
  // El gate A3a NO se relajó: tocar el Documento sigue tumbando su firma.
  assert(
    !verifyInboundEnvio(sobre.replace("<MntTotal>6001", "<MntTotal>9999")).dtes[0].signatureOk,
    "tamper del Documento debe seguir invalidando la firma per-DTE",
  );
});

Deno.test("hasDoctypeOrEntity: detecta DOCTYPE/ENTITY, ignora XML limpio", () => {
  assert(hasDoctypeOrEntity(`<!DOCTYPE foo><a/>`), "DOCTYPE");
  assert(hasDoctypeOrEntity(`<!ENTITY lol "x">`), "ENTITY");
  assert(hasDoctypeOrEntity(`<?xml version="1.0"?>\n<!doctype a>\n<a/>`), "case-insensitive");
  assert(!hasDoctypeOrEntity(`<EnvioDTE xmlns="x"><SetDTE ID="y"/></EnvioDTE>`), "XML limpio no dispara");
});

Deno.test("verifyInboundEnvio: payload con DTD/ENTITY (billion-laughs/XXE) → rechazado ANTES de parsear (seguridad)", () => {
  // Sobre VÁLIDO y firmado: sanity de que sin DTD verifica.
  const signed = signXmlWithForgeKey(envelopeXml(), "SetDTE", "SetDoc", SII_NS, forgeKey("11111111-1"));
  assert(verifyInboundEnvio(signed).envelopeOk, "sanity: válido sin DTD");
  // Mismo sobre firmado pero con un DOCTYPE+ENTITY (billion-laughs) prependido: el guard
  // fail-closed lo rechaza ANTES del parse, aunque la firma interna fuera válida.
  const lol = `<?xml version="1.0"?>\n<!DOCTYPE EnvioDTE [<!ENTITY a "AA"><!ENTITY b "&a;&a;&a;">]>\n`;
  const withDtd = lol + signed.replace(/^<\?xml[^>]*\?>\s*/, "");
  const v = verifyInboundEnvio(withDtd);
  assert(!v.envelopeOk, "DTD/ENTITY → envelopeOk false (rechazo total)");
  assertEquals(v.dtes.length, 0, "no se extrae metadata de un payload hostil");
});

Deno.test("verifyInboundEnvio: SignatureMethod/DigestMethod fuera del perfil SII → rechazado (pin de algoritmos)", () => {
  const signed = signXmlWithForgeKey(envelopeXml(), "SetDTE", "SetDoc", SII_NS, forgeKey("11111111-1"));
  assert(verifyInboundEnvio(signed).envelopeOk, "sanity: rsa-sha1+sha1 verifica");
  const badSig = signed.replace(
    'Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"',
    'Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"',
  );
  assert(!verifyInboundEnvio(badSig).envelopeOk, "SignatureMethod no-SII → rechazado");
  const badDigest = signed.replace(
    'Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"',
    'Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"',
  );
  assert(!verifyInboundEnvio(badDigest).envelopeOk, "DigestMethod no-SII → rechazado");
});
