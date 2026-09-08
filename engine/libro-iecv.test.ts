// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// libro-iecv.test.ts — valida el Libro IEV/IEC: carátula ESPECIAL/TOTAL, resumen
// totalizado por tipo, detalle (incl. FC con IVARetTotal + IVA uso común/FctProp)
// y que la firma del EnvioLibro verifica.
// ============================================================================

import { assert, assertStringIncludes } from "jsr:@std/assert@1";
import forge from "npm:node-forge@1.3.1";
import { buildSignedLibroIecv, type LibroIecvInput } from "./libro-iecv.ts";
import { verifyForgeSignature } from "./xml-signature.ts";

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

Deno.test("IEV (Venta): carátula ESPECIAL/TOTAL + FolioNotificacion 1 + resumen por tipo + firma verifica", () => {
  const { pfxBytes, publicKey } = makeTestPfx();
  const input: LibroIecvInput = {
    tipoOperacion: "VENTA",
    rutEmisorLibro: "78416626-0",
    rutEnvia: "22222222-2",
    periodoTributario: "2026-06",
    fchResol: "2026-06-08",
    nroResol: 0,
    folioNotificacion: 1,
    envioId: "IEV202606",
    detalles: [
      { tipoDoc: 33, folio: 1, fecha: "2026-06-14", rut: "77777777-7", razonSocial: "Cliente Ltda", tasaIva: 19, montoNeto: 100000, montoIva: 19000, montoTotal: 119000 },
      { tipoDoc: 33, folio: 2, fecha: "2026-06-14", rut: "77777777-7", tasaIva: 19, montoNeto: 50000, montoIva: 9500, montoTotal: 59500 },
      { tipoDoc: 61, folio: 1, fecha: "2026-06-14", rut: "77777777-7", tasaIva: 19, montoNeto: 30000, montoIva: 5700, montoTotal: 35700 },
    ],
  };
  const { xml } = buildSignedLibroIecv(input, pfxBytes, "pass");
  const flat = xml.replace(/\r\n/g, "");
  assertStringIncludes(xml, `xsi:schemaLocation="http://www.sii.cl/SiiDte LibroCV_v10.xsd"`);
  assertStringIncludes(flat, `<TipoOperacion>VENTA</TipoOperacion><TipoLibro>ESPECIAL</TipoLibro><TipoEnvio>TOTAL</TipoEnvio><FolioNotificacion>1</FolioNotificacion>`);
  // Resumen tipo 33: 2 docs, neto 150000, iva 28500, total 178500.
  // TotMntExe/TotMntNeto/TotMntIVA son OBLIGATORIOS (minOccurs=1) → van aunque sean 0.
  assertStringIncludes(
    flat,
    `<TotalesPeriodo><TpoDoc>33</TpoDoc><TotDoc>2</TotDoc><TotMntExe>0</TotMntExe><TotMntNeto>150000</TotMntNeto><TotMntIVA>28500</TotMntIVA><TotMntTotal>178500</TotMntTotal></TotalesPeriodo>`,
  );
  // Resumen tipo 61 (orden ascendente, va después del 33)
  assertStringIncludes(flat, `<TpoDoc>61</TpoDoc><TotDoc>1</TotDoc><TotMntExe>0</TotMntExe><TotMntNeto>30000</TotMntNeto>`);
  // TmstFirma (obligatorio) tras el último Detalle, antes de la firma
  assertStringIncludes(flat, `<TmstFirma>2026-06-01T12:00:00</TmstFirma></EnvioLibro>`);
  assert(flat.indexOf("<TpoDoc>33</TpoDoc>") < flat.indexOf("<TpoDoc>61</TpoDoc>"), "resumen ascendente");
  assert(verifyForgeSignature(xml, publicKey), "la firma del EnvioLibro debe verificar");
});

Deno.test("IEC (Compra): FC con IndFactCompra+IVARetTotal + IVA uso común (FctProp) + FolioNotificacion 2", () => {
  const { pfxBytes, publicKey } = makeTestPfx();
  const input: LibroIecvInput = {
    tipoOperacion: "COMPRA",
    rutEmisorLibro: "78416626-0",
    rutEnvia: "22222222-2",
    periodoTributario: "2026-06",
    fchResol: "2026-06-08",
    nroResol: 0,
    folioNotificacion: 2,
    envioId: "IEC202606",
    factorProporcionalidad: 0.6,
    detalles: [
      { tipoDoc: 33, folio: 234, fecha: "2026-06-10", rut: "60000000-0", razonSocial: "Proveedor", tasaIva: 19, montoNeto: 26262, montoIva: 4990, montoTotal: 31252 },
      // factura del giro con IVA uso común
      { tipoDoc: 33, folio: 781, fecha: "2026-06-10", rut: "60000000-0", tasaIva: 19, montoNeto: 29845, montoIva: 5670, ivaUsoComun: 3402, montoTotal: 35515 },
      // factura de compra con retención total del IVA → retención vía OtrosImp CodImp=15 (mecanismo del
      // libro de COMPRAS, NO IVARetTotal que es de ventas). MntTotal = Neto + IVA − retención = Neto = 9739.
      { tipoDoc: 46, folio: 9, fecha: "2026-06-10", rut: "60000000-0", tasaIva: 19, montoNeto: 9739, montoIva: 1850, otrosImp: [{ codImp: 15, tasaImp: 19, mntImp: 1850 }], facturaCompra: true, montoTotal: 9739 },
    ],
  };
  const { xml } = buildSignedLibroIecv(input, pfxBytes, "pass");
  const flat = xml.replace(/\r\n/g, "");
  assertStringIncludes(flat, `<TipoOperacion>COMPRA</TipoOperacion>`);
  assertStringIncludes(flat, `<FolioNotificacion>2</FolioNotificacion>`);
  // FC 46: IndFactCompra tras TpoDoc; retención total vía OtrosImp CodImp=15 (NO IVARetTotal), antes de MntTotal.
  assertStringIncludes(flat, `<TpoDoc>46</TpoDoc><IndFactCompra>1</IndFactCompra><NroDoc>9</NroDoc>`);
  assertStringIncludes(flat, `<OtrosImp><CodImp>15</CodImp><TasaImp>19</TasaImp><MntImp>1850</MntImp></OtrosImp><MntTotal>9739</MntTotal>`);
  assert(!flat.includes("<IVARetTotal>"), "el libro de COMPRAS usa OtrosImp/15, NO IVARetTotal (campo de ventas)");
  // Resumen del tipo 46: TotOtrosImp CodImp 15 + TotMntTotal = Σ MntTotal (9739), sin TotIVARetTotal.
  assertStringIncludes(flat, `<TotOtrosImp><CodImp>15</CodImp><TotMntImp>1850</TotMntImp></TotOtrosImp>`);
  assertStringIncludes(flat, `<TotMntTotal>9739</TotMntTotal>`);
  // IVA uso común en el detalle + FctProp en el resumen del tipo 33
  assertStringIncludes(flat, `<IVAUsoComun>3402</IVAUsoComun>`);
  assertStringIncludes(flat, `<FctProp>0.6</FctProp>`);
  assert(verifyForgeSignature(xml, publicKey), "la firma del EnvioLibro debe verificar");
});

Deno.test("IEV: documento de monto 0 (NC/ND corrige-texto) → MntExe=0 (el SII exige ≥1 de [Exe/Neto/IVA])", () => {
  const { pfxBytes } = makeTestPfx();
  const input: LibroIecvInput = {
    tipoOperacion: "VENTA",
    rutEmisorLibro: "78416626-0",
    rutEnvia: "22222222-2",
    periodoTributario: "2026-06",
    fchResol: "2026-06-08",
    nroResol: 0,
    folioNotificacion: 1,
    envioId: "IEV202606",
    detalles: [
      // NC corrige-texto de monto 0: sin neto/exento/iva → debe emitir MntExe=0.
      { tipoDoc: 61, folio: 8, fecha: "2026-06-14", rut: "55555555-5", montoTotal: 0 },
    ],
  };
  const { xml } = buildSignedLibroIecv(input, pfxBytes, "pass");
  const flat = xml.replace(/\r\n/g, "");
  assertStringIncludes(flat, `<MntExe>0</MntExe><MntTotal>0</MntTotal>`);
});
