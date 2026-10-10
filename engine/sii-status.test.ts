// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

import { assert, assertEquals } from "jsr:@std/assert@1";
import { parseBoletaStatus, parseEnvioBoletaStatus } from "./sii-status.ts";

const ENVIO = {
  rut_emisor: "45000054-K",
  rut_envia: "8315495-0",
  trackid: 1014,
  fecha_recepcion: "30/07/2020 07:57:42",
  estado: "EPR",
  estadistica: [{
    tipo: 39,
    informados: 2,
    aceptados: 1,
    rechazados: 1,
    reparos: 0,
  }],
  detalle_rep_rech: [{
    folio: 1202,
    tipo: 39,
    estado: "RCH",
    descripcion: "Dte Rechazado",
    error: [{
      seccion: "HED",
      linea: 1,
      nivel: 3,
      codigo: 100,
      descripcion: "Error",
      detalle: "Detalle",
    }],
  }],
};

Deno.test("estado boleta: conserva HTTP, texto y campos nuevos sin inferir aceptación", () => {
  const payload = {
    codigo: "DOK",
    descripcion: "Datos coinciden",
    nuevo: { valor: 1 },
  };
  const raw = "  " + JSON.stringify(payload) + "\n";
  const result = parseBoletaStatus({
    status: 200,
    raw,
    contentType: "application/json",
  });
  assertEquals(result, {
    status: 200,
    raw,
    contentType: "application/json",
    parsing: "complete",
    data: { codigo: "DOK", descripcion: "Datos coinciden" },
    payload,
    observations: [],
  });
  assert(!("accepted" in result));
  assert(!("outcome" in result));
});

Deno.test("estado: conserva respuestas no interpretables, incluso errores HTTP", () => {
  for (const parse of [parseBoletaStatus, parseEnvioBoletaStatus]) {
    for (
      const raw of [
        "",
        "no autorizado",
        "<html>Error</html>",
        '{"codigo":',
        "null",
        "[]",
        '"texto"',
        "123",
        "true",
        "{}",
        '{"respuesta":{"codigo":"DOK"}}',
      ]
    ) {
      const result = parse({ status: 401, raw });
      assertEquals(result.status, 401);
      assertEquals(result.raw, raw);
      assertEquals(result.contentType, null);
      assertEquals(result.parsing, "unrecognized");
      assertEquals(result.data, {});
      assert(result.observations.length > 0);
    }
  }
  assertEquals(parseBoletaStatus({ status: 200, raw: "null" }).payload, null);
  assertEquals(
    parseBoletaStatus({ status: 500, raw: "no JSON" }).payload,
    undefined,
  );
});

Deno.test("estado boleta: recupera campos sin convertir tipos o inventar alias", () => {
  const cases = [
    { payload: { codigo: "DOK" }, data: { codigo: "DOK" } },
    {
      payload: { codigo: 1, descripcion: "Datos coinciden" },
      data: { descripcion: "Datos coinciden" },
    },
    { payload: { codigo: "DOK", descripcion: null }, data: { codigo: "DOK" } },
    {
      payload: { codigo: "", descripcion: "Sin código" },
      data: { descripcion: "Sin código" },
    },
    {
      payload: { codigo: "NUEVO", descripcion: "Nuevo estado" },
      data: { codigo: "NUEVO", descripcion: "Nuevo estado" },
    },
  ];
  for (const { payload, data } of cases) {
    const result = parseBoletaStatus({
      status: 200,
      raw: JSON.stringify(payload),
    });
    assertEquals(result.parsing, "partial");
    assertEquals(result.data, data);
    assertEquals(result.payload, payload);
    assert(result.observations.length > 0);
  }
});

Deno.test("estado envío: recupera estadísticas y detalle completo", () => {
  const result = parseEnvioBoletaStatus({
    status: 200,
    raw: JSON.stringify(ENVIO),
  });
  assertEquals(result.parsing, "complete");
  assertEquals(result.data, ENVIO);
  assertEquals(result.observations, []);
});

Deno.test("estado envío: tolera nulos y campos adicionales en detalle", () => {
  const payload = structuredClone(ENVIO) as Record<string, unknown>;
  payload.detalle_rep_rech = [{
    folio: null,
    tipo: null,
    estado: "RCH",
    descripcion: "Firma inválida",
    error: [],
    nuevo: true,
  }];
  const result = parseEnvioBoletaStatus({
    status: 200,
    raw: JSON.stringify(payload),
  });
  assertEquals(result.parsing, "complete");
  assertEquals(result.data.detalle_rep_rech, [{
    folio: null,
    tipo: null,
    estado: "RCH",
    descripcion: "Firma inválida",
    error: [],
  }]);
  assertEquals(result.payload, payload);
});

Deno.test("estado envío: recupera arreglos mixtos e informa las posiciones originales", () => {
  const payload = {
    ...ENVIO,
    estadistica: [null, ENVIO.estadistica[0], {
      tipo: 41,
      aceptados: "1",
      nuevo: true,
    }],
    detalle_rep_rech: [false, {
      estado: "FUT",
      error: [null, { codigo: 12, seccion: "NUEVA" }],
    }],
  };
  const result = parseEnvioBoletaStatus({
    status: 200,
    raw: JSON.stringify(payload),
  });
  assertEquals(result.parsing, "partial");
  assertEquals(result.data.estadistica, [ENVIO.estadistica[0], { tipo: 41 }]);
  assertEquals(result.data.detalle_rep_rech, [{
    estado: "FUT",
    error: [{ seccion: "NUEVA", codigo: 12 }],
  }]);
  assertEquals(result.payload, payload);
  assert(result.observations.includes("estadistica[0]: se esperaba un objeto"));
  assert(
    result.observations.includes("estadistica[2].aceptados: tipo inesperado"),
  );
  assert(
    result.observations.includes(
      "detalle_rep_rech[1].estado: código desconocido",
    ),
  );
});

Deno.test("estado envío: no convierte tipos ni trunca enteros inseguros", () => {
  const payload = {
    ...ENVIO,
    estado: "FUT",
    trackid: "10a4",
    estadistica: {},
    detalle_rep_rech: null,
  };
  const result = parseEnvioBoletaStatus({
    status: 200,
    raw: JSON.stringify(payload),
  });
  assertEquals(result.parsing, "partial");
  assertEquals(result.data.estado, "FUT");
  assert(!("trackid" in result.data));
  assert(result.observations.includes("trackid: tipo inesperado"));
  assert(!("estadistica" in result.data));
  assert(!("detalle_rep_rech" in result.data));
  assertEquals(result.payload, payload);
  for (const trackid of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert(
      !("trackid" in
        parseEnvioBoletaStatus({
          status: 200,
          raw: JSON.stringify({ ...ENVIO, trackid }),
        }).data),
    );
  }
});

// ── Respuestas REALES del SII ───────────────────────────────────────────────
// Capturadas el 9-oct-2026 contra el ambiente de certificación (apicert.sii.cl), con
// dos sobres de boletas 39 cuyos folios el SII ya tenía. Lo único cambiado es
// `rut_envia`, que es el RUT de una persona.

const ENVIO_REAL_AL_SUBIR = '{\n"rut_emisor": "78416626-0",\n"rut_envia": "11111111-1",\n"trackid": 32670078,\n' +
  '"fecha_recepcion": "2026-10-09 21:28:39",\n"estado": "REC",\n"file": "envio.xml"\n}';

const ENVIO_REAL_AL_CONSULTAR =
  '{"rut_emisor":"78416626-0","rut_envia":"11111111-1","trackid":"32670078","fecha_recepcion":"09/10/2026 21:28:39",' +
  '"estado":"EPR","estadistica":[{"tipo":39,"informados":3,"aceptados":0,"rechazados":3,"reparos":0}],' +
  '"detalle_rep_rech":[' +
  [42, 43, 44].map((folio) =>
    `{"tipo":39,"folio":${folio},"estado":"RCH","descripcion":"DTE Rechazado","error":[{"seccion":"DTE","linea":0,` +
    `"nivel":3,"codigo":101,"descripcion":"Folio para este Tipo de documento ya fue recibido en el SII","detalle":null}]}`
  ).join(",") +
  "]}";

Deno.test("respuesta real: la consulta de un envío trae el trackid como TEXTO y `detalle` en null, y eso no es una rareza", () => {
  const r = parseEnvioBoletaStatus({ status: 200, raw: ENVIO_REAL_AL_CONSULTAR, contentType: "application/json" });
  assertEquals(r.parsing, "complete");
  assertEquals(r.observations, []);
  // Como viene: texto en la consulta. No se convierte.
  assertEquals(r.data.trackid, "32670078");
  assertEquals(r.data.estado, "EPR");
  assertEquals(r.data.estadistica, [{ tipo: 39, informados: 3, aceptados: 0, rechazados: 3, reparos: 0 }]);
  assertEquals(r.data.detalle_rep_rech?.length, 3);
  assertEquals(r.data.detalle_rep_rech?.[0], {
    tipo: 39,
    folio: 42,
    estado: "RCH",
    descripcion: "DTE Rechazado",
    error: [{
      seccion: "DTE",
      linea: 0,
      nivel: 3,
      codigo: 101,
      descripcion: "Folio para este Tipo de documento ya fue recibido en el SII",
      detalle: null,
    }],
  });
});

Deno.test("respuesta real: al subir el sobre el trackid viene como NÚMERO, y la fecha en otro formato que en la consulta", () => {
  const subir = JSON.parse(ENVIO_REAL_AL_SUBIR);
  const consultar = JSON.parse(ENVIO_REAL_AL_CONSULTAR);
  assertEquals([typeof subir.trackid, typeof consultar.trackid], ["number", "string"]);
  assertEquals(String(subir.trackid), consultar.trackid);
  assertEquals([subir.fecha_recepcion, consultar.fecha_recepcion], ["2026-10-09 21:28:39", "09/10/2026 21:28:39"]);
});

Deno.test("respuesta real: la consulta de UNA boleta sin los datos del documento contesta 200 con un texto, no un estado", () => {
  // GET /boleta.electronica/{rut}-{dv}-{tipo}-{folio}/estado, sin rut_receptor, monto ni
  // fechaEmision. El openapi los lista como parámetros; en la práctica son obligatorios.
  const sinDatos = parseBoletaStatus({ status: 200, raw: "falta rut_receptor", contentType: "application/json" });
  assertEquals(sinDatos.parsing, "unrecognized");
  assertEquals(sinDatos.data, {});
  assertEquals(sinDatos.raw, "falta rut_receptor");

  // Con los datos: el folio ya lo tenía el SII, con otros datos.
  const conDatos = parseBoletaStatus({
    status: 200,
    raw: '{"codigo":"DNK","descripcion":"Documento Recibido por el SII pero Datos NO Coinciden con los registrados"}',
    contentType: "application/json",
  });
  assertEquals(conDatos.parsing, "complete");
  assertEquals(conDatos.data.codigo, "DNK");
  assertEquals(conDatos.observations, []);
});

Deno.test("respuesta real: los cuatro códigos de la consulta de una boleta, como los mandó el SII", () => {
  // Con rut_receptor, dv_receptor, monto y fechaEmision. Certificación, 9-oct-2026.
  const reales: [string, string, string][] = [
    // Aceptada dentro de un sobre, consultada con sus datos.
    ["DOK", "Documento Recibido por el SII. Datos Coinciden con los Registrados", "la tiene, y es esa"],
    // La misma boleta, consultada con otro monto.
    ["DNK", "Documento Recibido por el SII pero Datos NO Coinciden con los registrados", "la tiene con otros datos"],
    // Un folio de un rango autorizado que nunca se mandó.
    ["FAU", "Documento No Recibido por el SII", "no la recibió"],
    // Un folio fuera de todo rango autorizado.
    ["FNA", "Documento No Autorizado", "ese folio no está autorizado"],
  ];
  for (const [codigo, descripcion] of reales) {
    const r = parseBoletaStatus({ status: 200, raw: JSON.stringify({ codigo, descripcion }), contentType: "application/json" });
    assertEquals([r.parsing, r.data.codigo, r.data.descripcion, r.observations], ["complete", codigo, descripcion, []]);
  }
});
