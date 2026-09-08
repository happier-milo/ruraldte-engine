// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// libro-guia.test.ts — valida el Libro de Guías de Despacho: carátula (sin
// TipoOperacion) + resumen (venta/anuladas/traslados) + detalle (Anulado/TpoOper)
// + firma del EnvioLibro. Modela los 3 casos del set 4897296/4897297.
// ============================================================================

import { assert, assertStringIncludes } from "jsr:@std/assert@1";
import forge from "npm:node-forge@1.3.1";
import { buildSignedLibroGuia, type LibroGuiaInput } from "./libro-guia.ts";
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

Deno.test("Libro de Guías: carátula sin TipoOperacion + resumen venta/anulada + detalle TpoOper/Anulado + firma", () => {
  const { pfxBytes, publicKey } = makeTestPfx();
  const input: LibroGuiaInput = {
    rutEmisorLibro: "78416626-0",
    rutEnvia: "22222222-2",
    periodoTributario: "2026-06",
    fchResol: "2026-06-08",
    nroResol: 0,
    folioNotificacion: 3,
    envioId: "LGD202606",
    detalles: [
      // caso 1: traslado interno entre bodegas (no venta)
      { folio: 1, tpoOper: 5, fecha: "2026-06-14", rut: "78416626-0", montoTotal: 50000 },
      // caso 2: venta facturada en el período
      { folio: 2, tpoOper: 1, fecha: "2026-06-14", rut: "77777777-7", razonSocial: "Cliente", montoNeto: 100000, tasaIva: 19, iva: 19000, montoTotal: 119000 },
      // caso 3: guía anulada (post-envío)
      { folio: 3, anulado: 2, tpoOper: 1, fecha: "2026-06-14", rut: "77777777-7", montoTotal: 0 },
    ],
  };
  const { xml } = buildSignedLibroGuia(input, pfxBytes, "pass");
  const flat = xml.replace(/\r\n/g, "");
  assertStringIncludes(xml, `xsi:schemaLocation="http://www.sii.cl/SiiDte LibroGuia_v10.xsd"`);
  assert(!flat.includes("TipoOperacion"), "el Libro de Guías NO lleva TipoOperacion");
  assertStringIncludes(flat, `<TipoLibro>ESPECIAL</TipoLibro><TipoEnvio>TOTAL</TipoEnvio><FolioNotificacion>3</FolioNotificacion>`);
  // Resumen: 1 venta (caso 2) por 119000, 1 anulada (caso 3)
  assertStringIncludes(flat, `<TotGuiaAnulada>1</TotGuiaAnulada><TotGuiaVenta>1</TotGuiaVenta><TotMntGuiaVta>119000</TotMntGuiaVta>`);
  // TotTraslado solo del traslado interno (TpoOper 5); la VENTA (1) NO va en TotTraslado
  // — su TpoTraslado enum es {2..9} (verificado vs LibroGuia_v10.xsd con xmllint).
  assertStringIncludes(flat, `<TotTraslado><TpoTraslado>5</TpoTraslado>`);
  assert(!flat.includes("<TpoTraslado>1</TpoTraslado>"), "venta (1) no es un TpoTraslado válido");
  // TmstFirma (obligatorio) tras el Detalle
  assertStringIncludes(flat, `<TmstFirma>2026-06-01T12:00:00</TmstFirma></EnvioLibro>`);
  // Detalle caso 1 traslado interno (TpoOper 5), caso 3 anulada
  assertStringIncludes(flat, `<Detalle><Folio>1</Folio><TpoOper>5</TpoOper>`);
  assertStringIncludes(flat, `<Detalle><Folio>3</Folio><Anulado>2</Anulado><TpoOper>1</TpoOper>`);
  assert(verifyForgeSignature(xml, publicKey), "la firma del EnvioLibro debe verificar");
});
