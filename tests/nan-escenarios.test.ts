// S9: los escenarios de NaN existen con los nombres del plan y el runner los
// resuelve sin tocar el driver de host.
import assert from "node:assert/strict";
import test from "node:test";

import { nanScenarios, type NanDeps } from "../src/harness/scenarios-nan.ts";
import { crearMemoriaKey, NAN_FALTA_KEY } from "../src/nan/key.ts";
import { runHeadlessOnce, type RunnerDeps } from "../src/harness/runner.ts";
import type { StreamPiAi } from "../src/nan/cliente.ts";

const deps: NanDeps = {
  fetchImpl: async () => ({ ok: false, status: 0, body: null }),
  almacenKey: crearMemoriaKey(null),
  streamPiAi: (() => {
    throw new Error("no debería pedir");
  }) as unknown as StreamPiAi,
  reloj: { ahora: () => new Date("2025-06-01T12:00:00.000Z"), zona: () => "UTC" },
};

test("S9: exactamente nan.stream, nan.tool, nan.sin-key y nan.http-error", () => {
  assert.deepEqual(
    Object.keys(nanScenarios(deps)).sort(),
    ["nan.http-error", "nan.sin-key", "nan.stream", "nan.tool"],
  );
});

test("S9: el runner resuelve nan.sin-key (no dice 'escenario desconocido') y falla con el literal", async () => {
  const emitidos: string[] = [];
  const runnerDeps: RunnerDeps = {
    obs: {
      mono: () => 1,
      append: (linea: string) => {
        emitidos.push(linea);
        return 1;
      },
      setPhase: () => {},
      setVerdict: () => {},
      takePendingRequest: () => ({ runId: "r1", scenario: "nan.sin-key" }),
      hardKill: () => {},
    },
    mono: () => 1,
    wall: () => Date.now(),
    sleep: async () => {},
    nan: deps,
  };
  await runHeadlessOnce(runnerDeps);
  assert.ok(
    !emitidos.some((l) => l.includes("escenario desconocido")),
    "el runner no reconoció el escenario",
  );
  // nan.sin-key afirma el throw y termina ok: no hay js_error, y el mensaje
  // de falta de key no se registra (no aporta y no debe viajar).
  assert.ok(!emitidos.some((l) => l.includes('"ev":"js_error"')));
  assert.ok(!emitidos.some((l) => l.includes(NAN_FALTA_KEY)));
});
