// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// Render visual (dev): genera 3 muestras en /tmp →
//   /tmp/boleta-agua.pdf  (41 exenta, OFICIAL sin marca)
//   /tmp/boleta-luz.pdf   (39 afecta, OFICIAL sin marca, lectura kWh)
//   /tmp/boleta-demo.pdf  (41 exenta con watermark DEMO)
import { writeFileSync } from "node:fs";
import { generateBoletaElectronicaPdf } from "../src/lib/boleta-pdf.mjs";

const b64 = "MIIBnTCCAQYCQ" + "AbCd0123+/9z".repeat(13) + "==";
const TED = (td, rut, folio) =>
  `<TED version="1.0"><DD><RE>${rut}</RE><TD>${td}</TD><F>${folio}</F>` +
  `<FE>2026-06-01</FE><RR>12345678-9</RR><RSR>JUANA PÉREZ SOTO</RSR>` +
  `<MNT>8660</MNT><IT1>Servicio</IT1>` +
  `<CAF version="1.0"><DA><RE>${rut}</RE><RS>COMITE APR LOS AROMOS</RS>` +
  `<TD>${td}</TD><RNG><D>1001</D><H>1500</H></RNG><FA>2026-05-01</FA>` +
  `<RSAPK><M>${b64}</M><E>Aw==</E></RSAPK><IDK>300</IDK></DA>` +
  `<FRMA algoritmo="SHA1withRSA">${b64}</FRMA></CAF>` +
  `<TSTED>2026-06-01T09:00:00</TSTED></DD>` +
  `<FRMT algoritmo="SHA1withRSA">${b64}</FRMT></TED>`;

const emisorAgua = {
  rut: "65432109-8",
  razonSocial: "Comité de Agua Potable Rural Los Aromos",
  giro: "Servicio de Agua Potable Rural",
  direccion: "Camino Los Aromos s/n, Paine",
  region: "Región Metropolitana",
  email: "comité@apr-losaromos.cl",
};
const receptor = { rut: "12345678-9", nombre: "Juana Pérez Soto", direccion: "Parcela 12, sector Los Aromos" };

// ── AGUA 41 exenta — OFICIAL (sin watermark) ──
const agua = await generateBoletaElectronicaPdf({
  tipoDte: 41, folio: 1048, fechaEmision: "2026-06-01",
  emisor: emisorAgua, siiSucursal: "Paine", receptor,
  periodo: "Mayo 2026", medidor: "A-042",
  lectura: { anterior: 1250, actual: 1264, consumo: 14, tarifa: 390, unidad: "m³" },
  items: [
    { nombre: "Cargo fijo mensual", cantidad: 1, precio: 3200 },
    { nombre: "Consumo de agua potable", cantidad: 14, precio: 390, valor: 5460 },
  ],
  totales: { exento: 8660, total: 8660 },
  vencimiento: "2026-06-15", resolucion: "Res. 80 del 2014",
  tedXml: TED(41, "65432109-8", 1048),
});
writeFileSync("/tmp/boleta-agua.pdf", agua.pdf);

// ── LUZ 39 afecta — OFICIAL (sin watermark), lectura en kWh ──
const luz = await generateBoletaElectronicaPdf({
  tipoDte: 39, folio: 304, fechaEmision: "2026-06-01",
  emisor: {
    rut: "65432109-8",
    razonSocial: "Comité de Agua Potable Rural Los Aromos",
    giro: "Distribución de energía eléctrica rural",
    direccion: "Camino Los Aromos s/n, Paine",
    region: "Región Metropolitana", email: "comité@apr-losaromos.cl",
  },
  siiSucursal: "Paine", receptor,
  periodo: "Mayo 2026", medidor: "E-118",
  lectura: { anterior: 4820, actual: 4995, consumo: 175, tarifa: 168, unidad: "kWh" },
  items: [
    { nombre: "Cargo fijo mensual", cantidad: 1, precio: 1500 },
    { nombre: "Consumo eléctrico", cantidad: 175, precio: 168, valor: 29400 },
  ],
  totales: { neto: 26050, iva: 4950, total: 31000 },
  vencimiento: "2026-06-15", resolucion: "Res. 80 del 2014",
  tedXml: TED(39, "65432109-8", 304),
});
writeFileSync("/tmp/boleta-luz.pdf", luz.pdf);

// ── DEMO 41 con watermark ──
const demo = await generateBoletaElectronicaPdf({
  tipoDte: 41, folio: 7, fechaEmision: "2026-06-01",
  emisor: { ...emisorAgua, razonSocial: "APR Demo Comunidad Rural" },
  siiSucursal: "Paine", receptor,
  periodo: "Mayo 2026", medidor: "A-001",
  lectura: { anterior: 1250, actual: 1264, consumo: 14, tarifa: 390, unidad: "m³" },
  items: [{ nombre: "Consumo de agua potable", cantidad: 14, precio: 390, valor: 5460 }],
  totales: { exento: 5460, total: 5460 },
  vencimiento: "2026-06-15", resolucion: "Res. 80 del 2014",
  watermark: "DEMO",
  tedXml: TED(41, "65432109-8", 7),
});
writeFileSync("/tmp/boleta-demo.pdf", demo.pdf);

console.log("agua 41 oficial → X Dim", agua.xDimMils.toFixed(1));
console.log("luz  39 oficial → X Dim", luz.xDimMils.toFixed(1));
console.log("demo 41 marca  → X Dim", demo.xDimMils.toFixed(1));
console.log("escrito: /tmp/boleta-{agua,luz,demo}.pdf");
