// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/** Respuesta HTTP de consulta. El cuerpo original siempre se conserva. */
export type SiiStatusResponse = {
  status: number;
  raw: string;
  contentType?: string | null;
};

export type BoletaStatusData = {
  codigo?: string;
  descripcion?: string;
};

export type EnvioBoletaStatusError = {
  seccion?: string;
  linea?: number;
  nivel?: number;
  codigo?: number;
  descripcion?: string;
  detalle?: string;
};

export type EnvioBoletaStatusDetail = {
  folio?: number | null;
  tipo?: number | null;
  estado?: string;
  descripcion?: string;
  error?: EnvioBoletaStatusError[];
};

export type EnvioBoletaStatusData = {
  rut_emisor?: string;
  rut_envia?: string;
  trackid?: number;
  fecha_recepcion?: string;
  estado?: string;
  estadistica?: {
    tipo?: number;
    informados?: number;
    aceptados?: number;
    rechazados?: number;
    reparos?: number;
  }[];
  detalle_rep_rech?: EnvioBoletaStatusDetail[];
};

/** complete describe el parseo, nunca la aceptación tributaria ni el éxito HTTP. */
export type ParsedSiiStatus<T> = {
  status: number;
  raw: string;
  contentType: string | null;
  parsing: "complete" | "partial" | "unrecognized";
  data: T;
  /** undefined si no se pudo decodificar JSON; null sigue siendo un JSON válido. */
  payload: unknown;
  observations: string[];
};

type Field = "string" | "integer" | "nullableInteger" | {
  codes: readonly string[];
} | { items: Shape };
type Shape = { [key: string]: Field };

const BOLETA: Shape = {
  codigo: {
    codes: [
      "DOK",
      "DNK",
      "FAU",
      "FNA",
      "FAN",
      "EMP",
      "TMD",
      "TMC",
      "MMD",
      "MMC",
      "AND",
      "ANC",
    ],
  },
  descripcion: "string",
};
const ENVIO: Shape = {
  rut_emisor: "string",
  rut_envia: "string",
  trackid: "integer",
  fecha_recepcion: "string",
  estado: {
    codes: [
      "CRT",
      "EPR",
      "FOK",
      "PRD",
      "RCH",
      "RCO",
      "VOF",
      "REC",
      "RFR",
      "RPR",
      "RPT",
      "RSC",
      "SOK",
      "RCT",
    ],
  },
  estadistica: {
    items: {
      tipo: "integer",
      informados: "integer",
      aceptados: "integer",
      rechazados: "integer",
      reparos: "integer",
    },
  },
  detalle_rep_rech: {
    items: {
      folio: "nullableInteger",
      tipo: "nullableInteger",
      estado: { codes: ["DOK", "RPR", "RCH", "RLV"] },
      descripcion: "string",
      error: {
        items: {
          seccion: {
            codes: [
              "ENV",
              "CRT",
              "TED",
              "CAF",
              "DTE",
              "HED",
              "DET",
              "REF",
              "DRG",
            ],
          },
          linea: "integer",
          nivel: "integer",
          codigo: "integer",
          descripcion: "string",
          detalle: "string",
        },
      },
    },
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readFields(
  value: Record<string, unknown>,
  shape: Shape,
  path: string,
  observations: string[],
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    const name = path + key;
    if (!Object.hasOwn(value, key)) {
      observations.push(name + ": campo ausente");
      continue;
    }
    const item = value[key];
    if (typeof field === "object" && "items" in field) {
      if (!Array.isArray(item)) {
        observations.push(name + ": se esperaba un arreglo");
        continue;
      }
      const entries: Record<string, unknown>[] = [];
      item.forEach((entry, index) => {
        const entryPath = name + "[" + index + "]";
        if (!isObject(entry)) {
          observations.push(entryPath + ": se esperaba un objeto");
          return;
        }
        const parsed = readFields(
          entry,
          field.items,
          entryPath + ".",
          observations,
        );
        if (Object.keys(parsed).length > 0) entries.push(parsed);
      });
      data[key] = entries;
    } else if (typeof field === "object") {
      if (typeof item !== "string" || item.trim() === "") {
        observations.push(name + ": se esperaba un código de texto no vacío");
        continue;
      }
      data[key] = item;
      if (!field.codes.includes(item)) {
        observations.push(name + ": código desconocido");
      }
    } else if (
      (field === "string" && typeof item === "string") ||
      (field !== "string" && typeof item === "number" &&
        Number.isSafeInteger(item)) ||
      (field === "nullableInteger" && item === null)
    ) {
      data[key] = item;
    } else {
      observations.push(name + ": tipo inesperado");
    }
  }
  return data;
}

function parseStatus<T>(
  response: SiiStatusResponse,
  shape: Shape,
): ParsedSiiStatus<T> {
  const observations: string[] = [];
  let payload: unknown;
  try {
    payload = JSON.parse(response.raw);
  } catch {
    observations.push("El cuerpo no es JSON válido");
  }
  let data: Record<string, unknown> = {};
  if (isObject(payload)) {
    data = readFields(payload, shape, "", observations);
  } else if (observations.length === 0) {
    observations.push("Se esperaba un objeto JSON");
  }
  return {
    status: response.status,
    raw: response.raw,
    contentType: response.contentType ?? null,
    parsing: Object.keys(data).length === 0
      ? "unrecognized"
      : observations.length > 0
      ? "partial"
      : "complete",
    data: data as T,
    payload,
    observations,
  };
}

/**
 * Parsea una consulta individual sin lanzar por cambios en el cuerpo del SII.
 * Recupera campos conocidos sin conversiones y conserva códigos nuevos literalmente.
 * Los campos adicionales permanecen en payload. Campos ausentes o inválidos producen
 * partial; un cuerpo sin campos reconocibles produce unrecognized.
 */
export function parseBoletaStatus(
  response: SiiStatusResponse,
): ParsedSiiStatus<BoletaStatusData> {
  return parseStatus<BoletaStatusData>(response, BOLETA);
}

/**
 * Parsea el estado del envío de boletas, incluyendo estadísticas y errores.
 * Recupera elementos reconocibles de arreglos mixtos; las posiciones originales
 * se conservan en payload y se identifican en observations. No infiere aceptación.
 */
export function parseEnvioBoletaStatus(
  response: SiiStatusResponse,
): ParsedSiiStatus<EnvioBoletaStatusData> {
  return parseStatus<EnvioBoletaStatusData>(response, ENVIO);
}
