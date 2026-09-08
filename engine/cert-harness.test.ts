// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildCertBoletaJson,
  type CertSetCase,
  computeBoletaTotals,
  runCertHarness,
} from "./cert-harness.ts";
import { type ConsumoFoliosCaratula } from "./consumo-folios.ts";

Deno.test("computeBoletaTotals: afecta deriva neto/iva desde bruto (con IVA)", () => {
  // bruto 11900 → neto round(11900/1.19)=10000, iva 1900
  assertEquals(computeBoletaTotals([{ nombre: "x", cantidad: 1, precio: 11900 }]), {
    neto: 10000,
    iva: 1900,
    exento: 0,
    total: 11900,
  });
});

Deno.test("computeBoletaTotals: mixta afecto + exento (CASO-4)", () => {
  const t = computeBoletaTotals([
    { nombre: "agua", cantidad: 1, precio: 5000, exento: true },
    { nombre: "servicio", cantidad: 2, precio: 1190 }, // bruto 2380
  ]);
  assertEquals(t.exento, 5000);
  assertEquals(t.neto, 2000); // round(2380/1.19)
  assertEquals(t.iva, 380); // 2380 - 2000
  assertEquals(t.total, 7380);
});

Deno.test("computeBoletaTotals: exenta pura (41)", () => {
  const t = computeBoletaTotals([
    { nombre: "agua", cantidad: 3, precio: 1000, exento: true },
  ]);
  assertEquals(t, { neto: 0, iva: 0, exento: 3000, total: 3000 });
});

Deno.test("buildCertBoletaJson: multi-ítem + referencia SET + emisor boleta", () => {
  const setCase: CertSetCase = {
    caso: "CASO-4",
    tipoDocumento: 39,
    items: [
      { nombre: "Agua", cantidad: 1, precio: 5000, exento: true },
      { nombre: "Cuota", cantidad: 1, precio: 1190 },
    ],
  };
  const totals = computeBoletaTotals(setCase.items);
  const json = buildCertBoletaJson({
    setCase,
    folio: 12,
    fechaEmision: "2026-06-07",
    totals,
    emisor: { rut: "78416626-0", legalName: "COMUNIDAD RURAL SPA", giro: "Servicios" },
    certRutCanonical: "78416626-0",
    pfxPassword: "secret",
    setFolioReferencia: 4,
  });

  // deno-lint-ignore no-explicit-any
  const doc = json.Documento as any;
  assertEquals(doc.Encabezado.IdentificacionDTE.TipoDTE, 39);
  assertEquals(doc.Encabezado.IdentificacionDTE.Folio, 12);
  assertEquals(doc.Encabezado.Emisor.RazonSocialBoleta, "COMUNIDAD RURAL SPA");
  assertEquals(doc.Detalles.length, 2);
  assertEquals(doc.Detalles[0].IndicadorExento, 1); // línea exenta
  assertEquals(doc.Detalles[1].IndicadorExento, 0); // línea afecta
  assertEquals(doc.Referencias[0].TipoDocumentoReferencia, "SET");
  assertEquals(doc.Referencias[0].RazonReferencia, "CASO-4");
  assertEquals(doc.Encabezado.Totales.MontoExento, 5000);
  assertEquals(doc.Encabezado.Totales.MontoNeto, 1000);
  // password no debe filtrarse fuera de Certificado
  // deno-lint-ignore no-explicit-any
  assertEquals((json.Certificado as any).Password, "secret");
});

const CARATULA: ConsumoFoliosCaratula = {
  rutEmisor: "78416626-0",
  rutEnvia: "22222222-2",
  fchResol: "2026-06-07",
  nroResol: 0,
  fchInicio: "2026-06-07",
  fchFinal: "2026-06-07",
  secEnvio: 1,
  tmstFirmaEnv: "2026-06-07T12:00:00",
};

Deno.test("runCertHarness: emite el set, arma y firma el RCOF", async () => {
  const cases: CertSetCase[] = [
    { caso: "CASO-1", tipoDocumento: 39, items: [{ nombre: "a", cantidad: 1, precio: 11900 }] },
    { caso: "CASO-2", tipoDocumento: 39, items: [{ nombre: "b", cantidad: 1, precio: 23800 }] },
    { caso: "CASO-3", tipoDocumento: 41, items: [{ nombre: "agua", cantidad: 1, precio: 5000, exento: true }] },
  ];

  let folioSeq = 100;
  const emitted: number[] = [];
  const result = await runCertHarness({
    cases,
    caratula: CARATULA,
    deps: {
      emitBoleta: ({ index }) => {
        const folio = folioSeq++;
        emitted.push(index);
        return Promise.resolve({ folio, trackId: `TRK-${folio}` });
      },
      signRcof: (xml, documentId) => `<SIGNED id="${documentId}">${xml.length}</SIGNED>`,
    },
  });

  // emitió en orden
  assertEquals(emitted, [0, 1, 2]);
  assertEquals(result.boletas.length, 3);
  assertEquals(result.boletas[0].folio, 100);
  assertEquals(result.boletas[0].trackId, "TRK-100");
  assertEquals(result.boletas[2].tipoDocumento, 41);
  // RCOF firmado (vía mock) presente
  assert(result.rcofXml.startsWith("<SIGNED id="));
  assert(result.rcofDocumentId.startsWith("CF_78416626-0_20260607_1"));
});
