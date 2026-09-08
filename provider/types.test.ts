// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

import { assertEquals } from "jsr:@std/assert@1";
import { ProviderResponseError } from "./types.ts";

function transient(status: number): boolean {
  return new ProviderResponseError("x", status, null, "ruraldte").isTransient;
}

Deno.test("isTransient: 5xx reintentable", () => {
  assertEquals(transient(500), true);
  assertEquals(transient(502), true);
  assertEquals(transient(503), true);
});

Deno.test("isTransient: 429/408/425 reintentables (rate limit + timeouts)", () => {
  assertEquals(transient(429), true);
  assertEquals(transient(408), true);
  assertEquals(transient(425), true);
});

Deno.test("isTransient: 4xx de payload NO reintentable", () => {
  assertEquals(transient(400), false);
  assertEquals(transient(401), false);
  assertEquals(transient(404), false);
  assertEquals(transient(422), false);
});
