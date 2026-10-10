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
    trackid: "1014",
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
