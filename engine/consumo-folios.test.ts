// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  buildConsumoFoliosXml,
  buildResumenes,
  type ConsumoFoliosCaratula,
  type EmittedBoletaRecord,
  foliosToRangos,
} from "./consumo-folios.ts";

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

Deno.test("foliosToRangos: comprime contiguos, dedup, ordena", () => {
  assertEquals(foliosToRangos([1, 2, 3, 5, 6, 10]), [
    { inicial: 1, final: 3 },
    { inicial: 5, final: 6 },
    { inicial: 10, final: 10 },
  ]);
  assertEquals(foliosToRangos([10, 1, 3, 2]), [
    { inicial: 1, final: 3 },
    { inicial: 10, final: 10 },
  ]);
  assertEquals(foliosToRangos([7, 7, 7]), [{ inicial: 7, final: 7 }]);
  assertEquals(foliosToRangos([]), []);
});

Deno.test("buildResumenes: agrupa por tipo, suma montos, cuenta folios, comprime rangos", () => {
  const records: EmittedBoletaRecord[] = [
    { tipoDocumento: 39, folio: 1, mntNeto: 1000, mntIva: 190, mntTotal: 1190 },
    { tipoDocumento: 39, folio: 2, mntNeto: 1000, mntIva: 190, mntTotal: 1190 },
    { tipoDocumento: 39, folio: 3, mntNeto: 1000, mntIva: 190, mntTotal: 1190 },
    { tipoDocumento: 39, folio: 4, anulado: true, mntTotal: 0 },
    { tipoDocumento: 41, folio: 1, mntExento: 500, mntTotal: 500 },
    { tipoDocumento: 41, folio: 2, mntExento: 500, mntTotal: 500 },
  ];
  const res = buildResumenes(records);
  assertEquals(res.length, 2);

  const r39 = res.find((r) => r.tipoDocumento === 39)!;
  assertEquals(r39.mntNeto, 3000);
  assertEquals(r39.mntIva, 570);
  assertEquals(r39.tasaIva, 19);
  assertEquals(r39.mntExento, undefined);
  assertEquals(r39.mntTotal, 3570);
  assertEquals(r39.foliosEmitidos, 3);
  assertEquals(r39.foliosAnulados, 1);
  assertEquals(r39.foliosUtilizados, 4);
  assertEquals(r39.rangoUtilizados, [{ inicial: 1, final: 3 }]);
  assertEquals(r39.rangoAnulados, [{ inicial: 4, final: 4 }]);

  const r41 = res.find((r) => r.tipoDocumento === 41)!;
  assertEquals(r41.mntExento, 1000);
  assertEquals(r41.mntNeto, undefined);
  assertEquals(r41.mntIva, undefined);
  assertEquals(r41.tasaIva, undefined);
  assertEquals(r41.mntTotal, 1000);
  assertEquals(r41.foliosEmitidos, 2);
  assertEquals(r41.foliosAnulados, 0);
  assertEquals(r41.rangoAnulados, undefined);
});

Deno.test("buildConsumoFoliosXml: estructura, orden de elementos y montos exentos en 41", () => {
  const res = buildResumenes([
    { tipoDocumento: 41, folio: 90, mntExento: 7000, mntTotal: 7000 },
    { tipoDocumento: 41, folio: 91, mntExento: 3000, mntTotal: 3000 },
  ]);
  const { xml, documentId } = buildConsumoFoliosXml({ caratula: CARATULA, resumenes: res });

  assertEquals(documentId, "CF_78416626-0_20260606_1");
  assert(xml.startsWith('<?xml version="1.0" encoding="ISO-8859-1"?>'));
  // Root con xsi:schemaLocation — el gateway SII identifica el schema por este
  // atributo (sin él: SCH-00001 Invalid Schema Name, verificado vivo 2026-06-12).
  assert(xml.includes(
    '<ConsumoFolios xmlns="http://www.sii.cl/SiiDte" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xsi:schemaLocation="http://www.sii.cl/SiiDte ConsumoFolio_v10.xsd" version="1.0">',
  ));
  assert(xml.includes(`<DocumentoConsumoFolios ID="${documentId}">`));

  // Orden carátula: RutEmisor → RutEnvia → … → TmstFirmaEnv
  assert(xml.indexOf("<RutEmisor>") < xml.indexOf("<RutEnvia>"));
  assert(xml.indexOf("<FchFinal>") < xml.indexOf("<SecEnvio>"));
  assert(xml.indexOf("<SecEnvio>") < xml.indexOf("<TmstFirmaEnv>"));
  // Carátula antes del Resumen
  assert(xml.indexOf("</Caratula>") < xml.indexOf("<Resumen>"));

  // Boleta exenta 41: MntExento presente, sin MntNeto/MntIva
  assert(xml.includes("<MntExento>10000</MntExento>"));
  assert(!xml.includes("<MntNeto>"));
  assert(!xml.includes("<MntIva>"));
  assert(xml.includes("<MntTotal>10000</MntTotal>"));
  assert(xml.includes("<TipoDocumento>41</TipoDocumento>"));
  assert(xml.includes(
    "<RangoUtilizados>\r\n<Inicial>90</Inicial>\r\n<Final>91</Final>\r\n</RangoUtilizados>",
  ));
  // Forma PRETTY (CRLF entre tags): el gateway legacy del SII (canal del RVD)
  // es line-based con tope ~4096/línea — el compacto en 1 línea rebota
  // SCH-00001 (verificado vivo 2026-06-12). La firma usa C14N real en contexto,
  // así que el whitespace emitido forma parte de lo firmado y verifica igual.
  assert(xml.startsWith(`<?xml version="1.0" encoding="ISO-8859-1"?>\r\n<ConsumoFolios`));
  assert(xml.split("\r\n").every((l) => l.length < 4000));
});

Deno.test("buildConsumoFoliosXml: valida coherencia de folios y cantidad de resúmenes", () => {
  // FoliosUtilizados ≠ emitidos + anulados
  assertThrows(
    () =>
      buildConsumoFoliosXml({
        caratula: CARATULA,
        resumenes: [{
          tipoDocumento: 39,
          mntTotal: 100,
          foliosEmitidos: 1,
          foliosAnulados: 0,
          foliosUtilizados: 5, // mal
          rangoUtilizados: [{ inicial: 1, final: 1 }],
        }],
      }),
    Error,
    "FoliosUtilizados",
  );

  // Suma de RangoUtilizados ≠ FoliosEmitidos
  assertThrows(
    () =>
      buildConsumoFoliosXml({
        caratula: CARATULA,
        resumenes: [{
          tipoDocumento: 39,
          mntTotal: 100,
          foliosEmitidos: 3,
          foliosAnulados: 0,
          foliosUtilizados: 3,
          rangoUtilizados: [{ inicial: 1, final: 1 }], // suma 1 ≠ 3
        }],
      }),
    Error,
    "RangoUtilizados",
  );

  // 0 resúmenes
  assertThrows(
    () => buildConsumoFoliosXml({ caratula: CARATULA, resumenes: [] }),
    Error,
    "1 a 3",
  );
});
