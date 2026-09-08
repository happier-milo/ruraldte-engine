// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// Servidor HTTP mínimo del servicio PDF de RuralDTE (standalone, stateless).
// Rutas (POST, JSON):
//   /pdf/boleta      {BoletaPdfInput}  → {ok, pdfBase64, sizeBytes, xDimMils, xDimOk}
//   /pdf/factura     {FacturaPdfInput} → {…, cedible, oversize}  (factura/NC/ND 33/34/56/61,
//                                          guía 52, exportación 110/111/112, liquidación 43, FC 46)
//   /pdf/factura-set {docs:[FacturaPdfInput]} → {…, pageCount, pages, allXDimOk}  (set cert, 1 pág/doc)
//   GET /health      → {ok:true}
// Auth opcional: si RENDER_SECRET está seteado, exige header x-render-secret.
// La persistencia (Storage/S3/disco) es responsabilidad del caller.
import { createServer } from "node:http";
import { generateBoletaElectronicaPdf } from "./lib/boleta-pdf.mjs";
import { generateFacturaPdf, generateFacturaSetPdf } from "./lib/factura-pdf.mjs";
import { MIN_X_DIM_MILS } from "./lib/pdf417.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const SECRET = process.env.RENDER_SECRET ?? "";

// Campos que todo DTE necesita para el render (mismo set que boleta y factura).
function assertDteBody(body) {
  const required = ["tipoDte", "folio", "fechaEmision", "emisor", "items", "totales", "tedXml"];
  for (const k of required) {
    if (body[k] === undefined || body[k] === null) throw new Error(`${k} is required`);
  }
  if (!body.emisor?.rut || !body.emisor?.razonSocial) {
    throw new Error("emisor.rut y emisor.razonSocial son obligatorios");
  }
}

async function renderBoleta(body) {
  assertDteBody(body);
  const { pdf, xDimMils } = await generateBoletaElectronicaPdf(body);
  return {
    ok: true,
    pdfBase64: Buffer.from(pdf).toString("base64"),
    sizeBytes: pdf.length,
    xDimMils: Math.round(xDimMils * 10) / 10,
    xDimOk: xDimMils >= MIN_X_DIM_MILS,
  };
}

async function renderFactura(body) {
  assertDteBody(body);
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new Error("items must be a non-empty array");
  }
  const { pdf, xDimMils, cedible } = await generateFacturaPdf(body);
  return {
    ok: true,
    pdfBase64: Buffer.from(pdf).toString("base64"),
    sizeBytes: pdf.length,
    xDimMils: Math.round(xDimMils * 10) / 10,
    xDimOk: xDimMils >= MIN_X_DIM_MILS,
    cedible,
    // El Upload de Muestras Impresas del SII rechaza archivos > 500 KB (manual §1.5).
    oversize: pdf.length > 500 * 1024,
  };
}

async function renderFacturaSet(body) {
  if (!Array.isArray(body.docs) || body.docs.length === 0) {
    throw new Error("docs must be a non-empty array");
  }
  const { pdf, pages } = await generateFacturaSetPdf(body.docs);
  return {
    ok: true,
    pdfBase64: Buffer.from(pdf).toString("base64"),
    sizeBytes: pdf.length,
    pageCount: pages.length,
    pages: pages.map((p) => ({ ...p, xDimMils: Math.round(p.xDimMils * 10) / 10 })),
    allXDimOk: pages.every((p) => p.xDimMils >= MIN_X_DIM_MILS),
    // El set completo (≈32 págs con timbres raster) ronda 2-3 MB; avisa sobre 5 MB.
    oversize: pdf.length > 5 * 1024 * 1024,
  };
}

const ROUTES = {
  "/pdf/boleta": renderBoleta,
  "/pdf/factura": renderFactura,
  "/pdf/factura-set": renderFacturaSet,
};

const server = createServer(async (req, res) => {
  const send = (status, payload) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });
  const handler = ROUTES[req.url ?? ""];
  if (req.method !== "POST" || !handler) return send(404, { error: "not found" });
  if (SECRET && req.headers["x-render-secret"] !== SECRET) return send(401, { error: "unauthorized" });
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    send(200, await handler(body));
  } catch (err) {
    send(400, { error: err?.message ?? String(err) });
  }
});
server.listen(PORT, () => console.log(`ruraldte pdf-service escuchando en :${PORT}`));
