// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// factura-dte.test.ts — valida el Documento de factura/NC/ND (33/34/56/61) y el
// sobre EnvioDTE: estructura vs el oráculo F60T33 + deltas vs boleta (RznSoc/
// Acteco/GiroRecep/TasaIVA/FchRef/CodRef) + crypto del sobre ("firmar-lo-que-
// serializo" + verificación de la firma del SET) + SubTotDTE multi-tipo.
// ============================================================================

import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import forge from "npm:node-forge@1.3.1";
import {
  buildFacturaDocumento,
  type FacturaDteInput,
  type FacturaDteItem,
  buildSignedFacturaDte,
  montosDeLinea,
} from "./factura-dte.ts";
import { buildEnvioDte } from "./envio-dte.ts";
import { canonicalize, parseXml } from "./c14n.ts";

function genCafXml(tipoDte: number): string {
  const kp = forge.pki.rsa.generateKeyPair({ bits: 512 });
  return (
    `<?xml version="1.0"?><AUTORIZACION><CAF version="1.0"><DA>` +
    `<RE>78416626-0</RE><RS>COMUNIDAD RURAL SPA</RS><TD>${tipoDte}</TD>` +
    `<RNG><D>1</D><H>50</H></RNG><FA>2026-06-12</FA>` +
    `<RSAPK><M>abc==</M><E>Aw==</E></RSAPK><IDK>100</IDK></DA>` +
    `<FRMA algoritmo="SHA1withRSA">deadbeef==</FRMA></CAF>` +
    `<RSASK>${forge.pki.privateKeyToPem(kp.privateKey)}</RSASK></AUTORIZACION>`
  );
}

function makeTestPfx(): { pfxBytes: Uint8Array; publicKey: forge.pki.rsa.PublicKey } {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [{ name: "commonName", value: "TEST" }, { name: "serialNumber", value: "22222222-2" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], "pass", { algorithm: "3des" });
  const der = forge.asn1.toDer(p12).getBytes();
  const bytes = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) bytes[i] = der.charCodeAt(i);
  return { pfxBytes: bytes, publicKey: keys.publicKey };
}

const EMISOR = {
  rut: "78416626-0",
  razonSocial: "COMUNIDAD RURAL SPA",
  giro: "PLATAFORMA SAAS Y SERVICIOS DE TECNOLOGÍA",
  acteco: 620200,
  dirOrigen: "Martínez de Rozas 3550",
  cmnaOrigen: "Quinta Normal",
  ciudadOrigen: "Santiago",
};
const RECEPTOR = {
  rut: "77777777-7",
  razonSocial: "EMPRESA LTDA",
  giro: "COMPUTACION",
  dirRecep: "SAN DIEGO 2222",
  cmnaRecep: "LA FLORIDA",
  ciudadRecep: "SANTIAGO",
};

function facturaAfecta(folio: number): FacturaDteInput {
  return {
    tipoDte: 33,
    folio,
    fechaEmision: "2026-06-12",
    formaPago: 1,
    emisor: EMISOR,
    receptor: RECEPTOR,
    items: [
      { nombre: "Parlantes Multimedia", cantidad: 2, precio: 45000, codigo: { tipo: "INT1", valor: "011" } },
      { nombre: "Mouse Inalambrico", cantidad: 1, precio: 10000 },
    ],
    totals: { neto: 100000, iva: 19000, exento: 0, total: 119000 },
    cafXml: genCafXml(33),
    tstedIso: "2026-06-12T09:33:20",
    tmstFirma: "2026-06-12T09:33:20",
    documentId: "F33T100",
  };
}

Deno.test("buildFacturaDocumento: normaliza el RUTRecep (sin puntos, DV mayúscula) en XML Y TED", () => {
  const input = { ...facturaAfecta(100), receptor: { ...RECEPTOR, rut: "76.543.210-k" } };
  const { documento } = buildFacturaDocumento(input);
  assertStringIncludes(documento, "<RUTRecep>76543210-K</RUTRecep>"); // XML
  assertStringIncludes(documento, "<RR>76543210-K</RR>"); // TED (DD)
  assert(!documento.includes("76.192.083"));
  assert(!documento.includes("76543210-k"));
});

Deno.test("factura 33 (afecta): Emisor RznSoc/GiroEmis/Acteco + Receptor GiroRecep + Totales TasaIVA", () => {
  const { documento } = buildFacturaDocumento(facturaAfecta(100));
  // Deltas vs boleta: RznSoc/GiroEmis (no RznSocEmisor) + Acteco obligatorio, en orden.
  assertStringIncludes(
    documento,
    `<Emisor><RUTEmisor>78416626-0</RUTEmisor><RznSoc>COMUNIDAD RURAL SPA</RznSoc>` +
      `<GiroEmis>PLATAFORMA SAAS Y SERVICIOS DE TECNOLOGÍA</GiroEmis><Acteco>620200</Acteco>`,
  );
  assert(!documento.includes("RznSocEmisor"), "factura NO usa RznSocEmisor (eso es boleta)");
  assertStringIncludes(documento, "<CiudadOrigen>Santiago</CiudadOrigen>");
  // Receptor con GiroRecep + DirRecep/CmnaRecep/CiudadRecep
  assertStringIncludes(
    documento,
    `<Receptor><RUTRecep>77777777-7</RUTRecep><RznSocRecep>EMPRESA LTDA</RznSocRecep>` +
      `<GiroRecep>COMPUTACION</GiroRecep><DirRecep>SAN DIEGO 2222</DirRecep>` +
      `<CmnaRecep>LA FLORIDA</CmnaRecep><CiudadRecep>SANTIAGO</CiudadRecep></Receptor>`,
  );
  // Totales afecta: MntNeto + TasaIVA + IVA + MntTotal (en ese orden XSD)
  assertStringIncludes(
    documento,
    `<Totales><MntNeto>100000</MntNeto><TasaIVA>19</TasaIVA><IVA>19000</IVA><MntTotal>119000</MntTotal></Totales>`,
  );
  // Detalle con CdgItem + sin IndServicio (eso es boleta)
  assertStringIncludes(
    documento,
    `<Detalle><NroLinDet>1</NroLinDet><CdgItem><TpoCodigo>INT1</TpoCodigo><VlrCodigo>011</VlrCodigo></CdgItem>` +
      `<NmbItem>Parlantes Multimedia</NmbItem><QtyItem>2</QtyItem><PrcItem>45000</PrcItem><MontoItem>90000</MontoItem></Detalle>`,
  );
  assert(!documento.includes("IndServicio"), "factura NO lleva IndServicio");
});

Deno.test("REGRESIÓN cert folio 44: glosa con em-dash (U+2014) firma sin tirar y sale Latin-1", () => {
  // La glosa REAL que dejó el folio 44 en manual_pending (config_error): el em-dash
  // reventaba toLatin1 al firmar el TED. Ahora se translitera a '-' en NmbItem Y en IT1.
  const { pfxBytes } = makeTestPfx();
  const input = facturaAfecta(44);
  input.items = [{ nombre: "Servicio RuralDTE — smoke post-cert NC61", cantidad: 1, precio: 100000 }];
  const signed = buildSignedFacturaDte(input, pfxBytes, "pass"); // no debe tirar
  assertStringIncludes(signed, "<NmbItem>Servicio RuralDTE - smoke post-cert NC61</NmbItem>"); // cuerpo
  assertStringIncludes(signed, "<IT1>Servicio RuralDTE - smoke post-cert NC61</IT1>"); // TED (DD)
  assert(!signed.includes("—"), "no debe quedar ningún em-dash crudo");
  for (let i = 0; i < signed.length; i++) {
    assert(signed.charCodeAt(i) <= 0xff, `char fuera de Latin-1 en pos ${i}: U+${signed.charCodeAt(i).toString(16)}`);
  }
});

Deno.test("factura 34 (exenta): MntExe sin TasaIVA ni IVA + IndExe en línea", () => {
  const input = facturaAfecta(101);
  input.tipoDte = 34;
  input.items = [{ nombre: "Servicio exento", cantidad: 1, precio: 50000, exento: true }];
  input.totals = { neto: 0, iva: 0, exento: 50000, total: 50000 };
  const { documento } = buildFacturaDocumento(input);
  assertStringIncludes(documento, `<Totales><MntExe>50000</MntExe><MntTotal>50000</MntTotal></Totales>`);
  assert(!documento.includes("TasaIVA"), "exenta no lleva TasaIVA");
  assert(!documento.includes("<IVA>"), "exenta no lleva IVA");
  assertStringIncludes(documento, `<NroLinDet>1</NroLinDet><IndExe>1</IndExe><NmbItem>Servicio exento</NmbItem>`);
});

Deno.test("NC 61: Referencia con FchRef OBLIGATORIO + CodRef 1=anula, en orden XSD", () => {
  const input = facturaAfecta(200);
  input.tipoDte = 61;
  input.documentId = "F61T200";
  input.cafXml = genCafXml(61);
  input.referencias = [
    { tipoDocRef: "33", folioRef: 100, fchRef: "2026-06-12", codRef: 1, razonRef: "Anula factura 100" },
  ];
  const { documento } = buildFacturaDocumento(input);
  assertStringIncludes(
    documento,
    `<Referencia><NroLinRef>1</NroLinRef><TpoDocRef>33</TpoDocRef><FolioRef>100</FolioRef>` +
      `<FchRef>2026-06-12</FchRef><CodRef>1</CodRef><RazonRef>Anula factura 100</RazonRef></Referencia>`,
  );
});

Deno.test("NC/ND sin referencia → throw (NC/ND obligan a referenciar el doc corregido)", () => {
  const nc = facturaAfecta(201);
  nc.tipoDte = 61;
  nc.referencias = undefined;
  assertThrows(() => buildFacturaDocumento(nc), Error, "requiere al menos una Referencia");
  const nd = facturaAfecta(202);
  nd.tipoDte = 56;
  nd.referencias = [];
  assertThrows(() => buildFacturaDocumento(nd), Error, "requiere al menos una Referencia");
});

Deno.test("Liquidación-Factura (43) sin tpoDocLiq en una línea → throw (TpoDocLiq obligatorio en el Detalle)", () => {
  const liq = facturaAfecta(203);
  liq.tipoDte = 43;
  liq.documentId = "F43T203";
  liq.cafXml = genCafXml(43);
  liq.items = [
    { nombre: "NETO FACTURAS", cantidad: 10, precio: 0, montoItem: 622357, tpoDocLiq: 30 },
    { nombre: "NETO FACTURAS ELECTRONICAS", cantidad: 47, precio: 0, montoItem: 101854 }, // ← sin tpoDocLiq
  ];
  liq.totals = { neto: 724211, iva: 137600, exento: 0, total: 861811 };
  // El XSD del 43 exige TpoDocLiq por línea → el motor debe fallar en build, no en Maullín.
  assertThrows(() => buildFacturaDocumento(liq), Error, "requiere tpoDocLiq");
  // Con tpoDocLiq en TODAS las líneas → construye OK y emite <TpoDocLiq> bajo raíz <Liquidacion>.
  liq.items[1].tpoDocLiq = 33;
  const { documento } = buildFacturaDocumento(liq);
  assertStringIncludes(documento, "<TpoDocLiq>33</TpoDocLiq>");
  assertStringIncludes(documento, "<Liquidacion ID=");
});

Deno.test("referencia de SET de certificación: TpoDocRef=SET + FolioRef=caso + FchRef + RazonRef (sin CodRef)", () => {
  const input = facturaAfecta(1);
  input.referencias = [{ tipoDocRef: "SET", folioRef: 1, fchRef: "2026-06-12", razonRef: "CASO-1" }];
  const { documento } = buildFacturaDocumento(input);
  assertStringIncludes(
    documento,
    `<Referencia><NroLinRef>1</NroLinRef><TpoDocRef>SET</TpoDocRef><FolioRef>1</FolioRef>` +
      `<FchRef>2026-06-12</FchRef><RazonRef>CASO-1</RazonRef></Referencia>`,
  );
  assert(!documento.includes("<CodRef>"), "el SET no lleva CodRef");
});

Deno.test("EnvioDTE: sobre con raíz EnvioDTE + schemaLocation EnvioDTE_v10.xsd + SubTotDTE multi-tipo", () => {
  const { pfxBytes } = makeTestPfx();
  const f33 = facturaAfecta(100);
  const f34 = { ...facturaAfecta(101), tipoDte: 34 as const, documentId: "F34T101", cafXml: genCafXml(34),
    items: [{ nombre: "Exento", cantidad: 1, precio: 5000, exento: true }],
    totals: { neto: 0, iva: 0, exento: 5000, total: 5000 } };
  const nc61: FacturaDteInput = { ...facturaAfecta(200), tipoDte: 61, documentId: "F61T200", cafXml: genCafXml(61),
    referencias: [{ tipoDocRef: "33", folioRef: 100, fchRef: "2026-06-12", codRef: 1, razonRef: "Anula" }] };
  const nd56: FacturaDteInput = { ...facturaAfecta(300), tipoDte: 56, documentId: "F56T300", cafXml: genCafXml(56),
    referencias: [{ tipoDocRef: "33", folioRef: 100, fchRef: "2026-06-12", codRef: 3, razonRef: "Corrige monto" }] };

  const dtes = [
    buildSignedFacturaDte(f33, pfxBytes, "pass"),
    buildSignedFacturaDte(f34, pfxBytes, "pass"),
    buildSignedFacturaDte(nc61, pfxBytes, "pass"),
    buildSignedFacturaDte(nd56, pfxBytes, "pass"),
  ];
  const { xml } = buildEnvioDte({
    setId: "SET_FACTURA",
    signedDtes: dtes,
    caratula: {
      rutEmisor: "78416626-0",
      rutEnvia: "22222222-2",
      rutReceptor: "60803000-K",
      fchResol: "2026-06-08",
      nroResol: 0,
      tmstFirmaEnv: "2026-06-12T22:11:10",
    },
    pfxBytes,
    password: "pass",
  });

  assert(xml.startsWith(`<?xml version="1.0" encoding="ISO-8859-1"?>`));
  assertStringIncludes(xml, `<EnvioDTE xmlns:xsi=`);
  assertStringIncludes(xml, `EnvioDTE_v10.xsd`);
  assertStringIncludes(xml, `xmlns="http://www.sii.cl/SiiDte">`);
  assert(xml.endsWith(`</Signature></EnvioDTE>`));
  // SubTotDTE ordenado ascendente por tipo: 33, 34, 56, 61 (1 c/u)
  assertStringIncludes(xml, `<SubTotDTE>\r\n<TpoDTE>33</TpoDTE>\r\n<NroDTE>1</NroDTE>\r\n</SubTotDTE>`);
  assertStringIncludes(xml, `<SubTotDTE>\r\n<TpoDTE>34</TpoDTE>\r\n<NroDTE>1</NroDTE>\r\n</SubTotDTE>`);
  assertStringIncludes(xml, `<SubTotDTE>\r\n<TpoDTE>56</TpoDTE>\r\n<NroDTE>1</NroDTE>\r\n</SubTotDTE>`);
  assertStringIncludes(xml, `<SubTotDTE>\r\n<TpoDTE>61</TpoDTE>\r\n<NroDTE>1</NroDTE>\r\n</SubTotDTE>`);
  assert(xml.indexOf("<TpoDTE>33</TpoDTE>") < xml.indexOf("<TpoDTE>61</TpoDTE>"), "SubTotDTE ascendente");
  // los 4 DTE incrustados
  for (const id of ["F33T100", "F34T101", "F61T200", "F56T300"]) {
    assert(xml.includes(`<Documento ID="${id}">`), `falta ${id}`);
  }
});

Deno.test("EnvioDTE: firmar-lo-que-serializo (digest del SetDTE recomputado == firmado) + firma del SET verifica", () => {
  const { pfxBytes, publicKey } = makeTestPfx();
  const dtes = [buildSignedFacturaDte(facturaAfecta(100), pfxBytes, "pass")];
  const { xml, setDigest } = buildEnvioDte({
    setId: "SOBRE_FACT",
    signedDtes: dtes,
    caratula: {
      rutEmisor: "78416626-0",
      rutEnvia: "22222222-2",
      rutReceptor: "60803000-K",
      fchResol: "2026-06-08",
      nroResol: 0,
      tmstFirmaEnv: "2026-06-12T22:11:10",
    },
    pfxBytes,
    password: "pass",
  });

  const doc = parseXml(xml);
  const setEl = doc.getElementsByTagName("SetDTE")[0];
  const md0 = forge.md.sha1.create();
  md0.update(canonicalize(setEl), "utf8");
  assertEquals(forge.util.encode64(md0.digest().getBytes()), setDigest, "digest recomputado == reportado");

  // firma del SET (la <Signature> hija directa de EnvioDTE) verifica sobre C14N(SignedInfo)
  const sigs = doc.getElementsByTagName("Signature");
  let setSig = null;
  for (let i = 0; i < sigs.length; i++) {
    if (sigs[i].parentNode.nodeName === "EnvioDTE") { setSig = sigs[i]; break; }
  }
  assert(setSig, "firma del SET no encontrada");
  const siC14n = canonicalize(setSig.getElementsByTagName("SignedInfo")[0]);
  assertStringIncludes(siC14n, `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`);
  const sv = setSig.getElementsByTagName("SignatureValue")[0].textContent.replace(/\s/g, "");
  const md = forge.md.sha1.create();
  md.update(siC14n, "utf8");
  assert(publicKey.verify(md.digest().getBytes(), forge.util.decode64(sv)), "la firma del SET debe verificar");
});

Deno.test("guía 52: IdDoc TipoDespacho+IndTraslado + sección Transporte entre Receptor y Totales", () => {
  const input = facturaAfecta(500);
  input.tipoDte = 52;
  input.documentId = "F52T500";
  input.cafXml = genCafXml(52);
  input.despacho = { tipoDespacho: 2, indTraslado: 1 };
  input.transporte = {
    patente: "GXXR12",
    rutTransportista: "76123456-7",
    chofer: { rut: "12345678-9", nombre: "Juan Perez" },
    dirDest: "Camino El Roble 100",
    cmnaDest: "Melipilla",
    ciudadDest: "Melipilla",
  };
  const { documento } = buildFacturaDocumento(input);
  // TipoDespacho + IndTraslado tras FchEmis en IdDoc
  assertStringIncludes(
    documento,
    `<IdDoc><TipoDTE>52</TipoDTE><Folio>500</Folio><FchEmis>2026-06-12</FchEmis>` +
      `<TipoDespacho>2</TipoDespacho><IndTraslado>1</IndTraslado>`,
  );
  // Transporte ENTRE </Receptor> y <Totales>, en orden XSD
  assertStringIncludes(
    documento,
    `</Receptor><Transporte><Patente>GXXR12</Patente><RUTTrans>76123456-7</RUTTrans>` +
      `<Chofer><RUTChofer>12345678-9</RUTChofer><NombreChofer>Juan Perez</NombreChofer></Chofer>` +
      `<DirDest>Camino El Roble 100</DirDest><CmnaDest>Melipilla</CmnaDest>` +
      `<CiudadDest>Melipilla</CiudadDest></Transporte><Totales>`,
  );
});

Deno.test("factura de compra 46: TpoTranCompra en IdDoc + ImptoReten en Totales (orden XSD, antes de MntTotal)", () => {
  const input = facturaAfecta(600);
  input.tipoDte = 46;
  input.documentId = "F46T600";
  input.cafXml = genCafXml(46);
  input.tpoTranCompra = 1;
  input.totals = {
    neto: 100000,
    iva: 19000,
    exento: 0,
    total: 119000,
    impuestosReten: [{ tipo: 15, tasa: 19, monto: 19000 }],
  };
  const { documento } = buildFacturaDocumento(input);
  assertStringIncludes(documento, `<FchEmis>2026-06-12</FchEmis><TpoTranCompra>1</TpoTranCompra>`);
  assertStringIncludes(
    documento,
    `<IVA>19000</IVA><ImptoReten><TipoImp>15</TipoImp><TasaImp>19</TasaImp>` +
      `<MontoImp>19000</MontoImp></ImptoReten><MntTotal>119000</MntTotal>`,
  );
});

// La representación impresa importa `montosDeLinea` en vez de replicar la cuenta. Esto amarra que lo
// que devuelve sea EXACTAMENTE lo que el builder escribe en el <Detalle>, rama por rama y en los dos
// subtipos, y fija los valores para que un cambio en la cuenta no pase callado por las dos rutas a la
// vez. `en33` = familia comercial (MontoItem entero); `en110` = subtipo Exportaciones (decimal/4).
Deno.test("montosDeLinea = lo que escribe el <Detalle> (MontoItem y DescuentoMonto), en todas las ramas y los dos subtipos", () => {
  const casos: Array<{ item: FacturaDteItem; en33: number; en110: number; descuentoMonto?: number }> = [
    // Pesos enteros: descuento % (set CASO 2), descuento $, recargo %, descuento y recargo $.
    { item: { nombre: "A", cantidad: 777, precio: 6014, descuentoPct: 10 }, en33: 4205590, en110: 4205590, descuentoMonto: 467288 },
    { item: { nombre: "B", cantidad: 3, precio: 1000, descuentoMonto: 250 }, en33: 2750, en110: 2750, descuentoMonto: 250 },
    { item: { nombre: "C", cantidad: 3, precio: 1000, recargoPct: 15 }, en33: 3450, en110: 3450 },
    { item: { nombre: "D", cantidad: 1000, precio: 50, descuentoMonto: 100, recargoMonto: 50 }, en33: 49950, en110: 49950, descuentoMonto: 100 },
    // Precio decimal: el PrcItem lo conserva en los dos subtipos; el MontoItem, solo en Exportaciones.
    { item: { nombre: "E", cantidad: 2, precio: 12.345678 }, en33: 25, en110: 24.6914 },
    // Recargo % fraccionario (cert 4907377-1, exportación): en 110 va solo RecargoPct y el MontoItem lo
    // absorbe con decimales; en 33 el recargo se redondea a pesos sobre el bruto.
    { item: { nombre: "F", cantidad: 1, precio: 1, recargoPct: 10 }, en33: 1, en110: 1.1 },
    { item: { nombre: "G", cantidad: 1, precio: 94, recargoPct: 10 }, en33: 103, en110: 103.4 },
    { item: { nombre: "H", cantidad: 1, precio: 999, recargoPct: 10 }, en33: 1099, en110: 1098.9 },
    // Descuento % fraccionario: el DescuentoMonto va entero en los dos (MntImpType); el bruto no.
    { item: { nombre: "I", cantidad: 1.5, precio: 999, descuentoPct: 10 }, en33: 1349, en110: 1348.5, descuentoMonto: 150 },
    { item: { nombre: "J", cantidad: 1036, precio: 194, descuentoPct: 5, exento: true }, en33: 190935, en110: 190935, descuentoMonto: 10049 },
    // MontoItem explícito (liquidación-factura 43): sin PrcItem, admite negativo, se redondea.
    { item: { nombre: "K", cantidad: 129, precio: 0, montoItem: 69180, tpoDocLiq: 33 }, en33: 69180, en110: 69180 },
    { item: { nombre: "L", cantidad: 1, precio: 0, montoItem: -52428.4, tpoDocLiq: 33 }, en33: -52428, en110: -52428 },
    // Línea sin valor (guía 52, traslado interno).
    { item: { nombre: "M", cantidad: 3, precio: 0, sinValor: true }, en33: 0, en110: 0 },
  ];
  for (const tipoDte of [33, 110] as const) {
    const input: FacturaDteInput = { ...facturaAfecta(7), tipoDte, cafXml: genCafXml(tipoDte), items: casos.map((c) => c.item) };
    const { documento } = buildFacturaDocumento(input);
    const detalles = documento.match(/<Detalle>[\s\S]*?<\/Detalle>/g) ?? [];
    assertEquals(detalles.length, casos.length);
    casos.forEach((c, i) => {
      const linea = `${tipoDte} línea ${c.item.nombre}`;
      const m = montosDeLinea(c.item, tipoDte);
      const xmlMonto = Number(detalles[i].match(/<MontoItem>([^<]+)<\/MontoItem>/)?.[1]);
      const xmlDesc = detalles[i].match(/<DescuentoMonto>([^<]+)<\/DescuentoMonto>/)?.[1];
      const desc = m.rama === "precio" ? m.descuentoMonto : undefined;
      assertEquals(xmlMonto, m.montoItem, `${linea}: <MontoItem> vs montosDeLinea`);
      assertEquals(m.montoItem, tipoDte === 33 ? c.en33 : c.en110, `${linea}: MontoItem fijado`);
      assertEquals(xmlDesc === undefined ? undefined : Number(xmlDesc), desc, `${linea}: <DescuentoMonto>`);
      assertEquals(desc, c.descuentoMonto, `${linea}: DescuentoMonto fijado`);
    });
  }
});

// Un DescuentoMonto/RecargoMonto explícito ya viene en pesos: con decimales, en la familia comercial no
// hay cómo escribirlo (MntImpType y MontoType son enteros), y redondearlo callado dejaría el Detalle
// distinto de los Totales que el llamador calculó con ese mismo monto. En Exportaciones sí tiene cómo.
Deno.test("montosDeLinea: DescuentoMonto/RecargoMonto explícito con decimales se rechaza en la familia comercial", () => {
  assertThrows(() => montosDeLinea({ cantidad: 1, precio: 1000, descuentoMonto: 150.5 }, 33), Error, "descuentoMonto=150.5");
  assertThrows(() => montosDeLinea({ cantidad: 1, precio: 1000, recargoMonto: 0.4 }, 61), Error, "recargoMonto=0.4");
  assertEquals(montosDeLinea({ cantidad: 1, precio: 1, recargoPct: 10, recargoMonto: 0.1 }, 110).montoItem, 1.1);
});

Deno.test("descuento por línea (set CASO 2): DescuentoPct+DescuentoMonto tras PrcItem, antes de MontoItem", () => {
  const input = facturaAfecta(2);
  input.items = [
    { nombre: "Pañuelo AFECTO", cantidad: 777, precio: 6014, descuentoPct: 10 },
    { nombre: "ITEM 2 AFECTO", cantidad: 722, precio: 5064, descuentoPct: 23 },
  ];
  const { documento } = buildFacturaDocumento(input);
  // MontoItem es NETO = Qty×Prc − DescuentoMonto (el SII lo valida así; el bruto da
  // reparo "Valor Detalle Distinto a Precio * Cantidad" — RVD cert T33 folio 2).
  // L1: bruto 777×6014=4.672.878, DescMonto round(×0,10)=467.288 → MontoItem 4.205.590.
  assertStringIncludes(
    documento,
    `<PrcItem>6014</PrcItem><DescuentoPct>10</DescuentoPct><DescuentoMonto>467288</DescuentoMonto><MontoItem>4205590</MontoItem>`,
  );
  // L2: bruto 722×5064=3.656.208, DescMonto round(×0,23)=840.928 → MontoItem 2.815.280.
  assertStringIncludes(
    documento,
    `<PrcItem>5064</PrcItem><DescuentoPct>23</DescuentoPct><DescuentoMonto>840928</DescuentoMonto><MontoItem>2815280</MontoItem>`,
  );
});

Deno.test("descuento global (set CASO 4): DscRcgGlobal DESPUÉS de Detalle y ANTES de Referencia (orden XSD)", () => {
  const input = facturaAfecta(4);
  input.descuentosGlobales = [{ tipo: "D", valorTipo: "%", valor: 23 }];
  input.referencias = [{ tipoDocRef: "SET", folioRef: 4, fchRef: "2026-06-14", razonRef: "CASO-4" }];
  const { documento } = buildFacturaDocumento(input);
  const iDet = documento.lastIndexOf("</Detalle>");
  const iDsc = documento.indexOf("<DscRcgGlobal>");
  const iRef = documento.indexOf("<Referencia>");
  assert(iDet < iDsc && iDsc < iRef, "orden esperado: Detalle < DscRcgGlobal < Referencia");
  assertStringIncludes(
    documento,
    `<DscRcgGlobal><NroLinDR>1</NroLinDR><TpoMov>D</TpoMov><TpoValor>%</TpoValor><ValorDR>23</ValorDR></DscRcgGlobal>`,
  );
});
