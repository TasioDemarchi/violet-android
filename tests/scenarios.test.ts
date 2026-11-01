/**
 * T5: escenarios de autoprueba (S3, S4, S7, S10, S12) con el módulo nativo
 * mockeado. El doble de VioletaObs registra las llamadas; el reloj `mono` es
 * simulado y lo avanza el `sleep` falso, así que los tiempos de A11 se
 * verifican exactos sin esperar reloj de pared. `selftest.block` se verifica
 * con un reloj `wall` falso que avanza por llamada y una aserción de que el
 * runner no usó la espera cooperativa (no cedió el control).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeadlessOnce, type RunnerDeps } from "../src/harness/runner.ts";
import { parseNdjson } from "../src/harness/record.ts";
import type { PendingRequest, VioletaObsModule } from "../src/harness/obs.ts";

// ---------------------------------------------------------------------------
// Dobles de test
// ---------------------------------------------------------------------------

interface VerdictCall {
  outcome: string;
  dataJson: string;
}

function makeDeps(request: PendingRequest | null) {
  const calls = {
    takePendingRequest: 0,
    append: [] as string[],
    setPhase: [] as string[],
    verdicts: [] as VerdictCall[],
    hardKill: 0,
  };

  const obs: VioletaObsModule = {
    mono: () => 0, // el runner no lo usa: inyecta su propio reloj en deps
    append: (line: string) => {
      calls.append.push(line);
      return calls.append.length; // seq simulado
    },
    setPhase: (phase: string) => {
      calls.setPhase.push(phase);
    },
    setVerdict: (outcome: string, dataJson: string) => {
      calls.verdicts.push({ outcome, dataJson });
    },
    takePendingRequest: () => {
      calls.takePendingRequest++;
      return request;
    },
    hardKill: () => {
      calls.hardKill++;
    },
  };

  let monoT = 0;
  let wallT = 0;
  const sleeps: number[] = [];
  const deps: RunnerDeps = {
    obs,
    mono: () => monoT,
    // el sleep falso avanza el reloj simulado y resuelve sin esperar nada
    sleep: async (ms: number) => {
      sleeps.push(ms);
      monoT += ms;
    },
    // reloj del busy-wait: avanza por llamada (si el spin no girara, no pasa el tiempo)
    wall: () => (wallT += 1000),
  };

  return {
    deps,
    calls,
    sleeps,
    registros: () => parseNdjson(calls.append.join("\n")),
    wallConsumido: () => wallT,
  };
}

const fases = (registros: ReturnType<ReturnType<typeof makeDeps>["registros"]>): string[] =>
  registros.filter((r) => r.ev === "phase").map((r) => (r.data as { name: string }).name);

// ---------------------------------------------------------------------------
// S12: los siete escenarios existen con las fases de A11 (nojs va aparte)
// ---------------------------------------------------------------------------

test("sin request pendiente: arranque manual, no emite nada y consulta el request una sola vez (A1)", async () => {
  const h = makeDeps(null);
  assert.equal(await runHeadlessOnce(h.deps), false);
  assert.equal(h.calls.takePendingRequest, 1, "una única llamada a takePendingRequest");
  assert.deepEqual(h.calls.append, [], "sin request no hay registros");
  assert.deepEqual(h.calls.setPhase, []);
  assert.deepEqual(h.calls.verdicts, []);
  assert.equal(h.calls.hardKill, 0);
});

test("selftest.ok: request, js_boot, fases boot/work/done con work de 1000 ms y veredicto ok", async () => {
  const h = makeDeps({ runId: "t-ok", scenario: "selftest.ok" });
  assert.equal(await runHeadlessOnce(h.deps), true);

  assert.equal(h.calls.takePendingRequest, 1, "una única llamada a takePendingRequest");
  const regs = h.registros();
  assert.deepEqual(
    regs.map((r) => r.ev),
    ["request", "js_boot", "phase", "phase", "phase", "verdict"],
  );
  assert.ok(regs.every((r) => r.src === "js"), "todo registro del runner es src:js");

  const [request, jsBoot] = regs;
  assert.deepEqual(request.data, { runId: "t-ok", scenario: "selftest.ok" });
  assert.deepEqual(jsBoot.data, {});
  assert.equal(jsBoot.phase, "-", "js_boot va antes de la primera fase (convención '-')");

  assert.deepEqual(fases(regs), ["boot", "work", "done"]);
  assert.deepEqual(h.calls.setPhase, ["boot", "work", "done"], "cada fase fijada para el heartbeat (A6)");

  const phaseRegs = regs.filter((r) => r.ev === "phase");
  assert.equal(phaseRegs[2].mono - phaseRegs[1].mono, 1000, "work dura 1000 ms (A11)");

  assert.deepEqual(h.calls.verdicts, [{ outcome: "ok", dataJson: "{}" }]);
  const verdict = regs[regs.length - 1];
  assert.deepEqual(verdict.data, { outcome: "ok" });
  assert.equal(verdict.phase, "done", "el registro verdict lleva la fase vigente");
});

test("selftest.phases: cinco fases con los tiempos exactos de A11 y verdict ok a los ~17100 ms", async () => {
  const h = makeDeps({ runId: "t-phases", scenario: "selftest.phases" });
  await runHeadlessOnce(h.deps);

  const regs = h.registros();
  const phaseRegs = regs.filter((r) => r.ev === "phase");
  assert.equal(phaseRegs.length, 5, "un registro ev:phase por cada fase de A11 (S4)");
  assert.deepEqual(fases(regs), ["boot", "p1", "p2", "hold", "done"]);

  const monos = Object.fromEntries(phaseRegs.map((r) => [(r.data as { name: string }).name, r.mono]));
  assert.equal(monos.boot, 0);
  assert.equal(monos.p1, 0, "p1 a los 0 ms");
  assert.equal(monos.p2, 1000, "p2 a los 1000 ms");
  assert.equal(monos.hold, 2000, "hold a los 2000 ms");
  assert.equal(monos.done, 17000, "done a los 17000 ms");
  assert.equal(monos.done - monos.hold, 15000, "hold dura 15000 ms exactos (ventana de S10)");

  const verdict = regs[regs.length - 1];
  assert.equal(verdict.ev, "verdict");
  assert.equal(verdict.mono - monos.done, 100, "verdict ok a los ~17100 ms");
  assert.deepEqual(h.calls.verdicts, [{ outcome: "ok", dataJson: "{}" }]);
});

test("selftest.throw: el Error se lanza dentro del dispatcher y deja js_error + verdict crash", async () => {
  const h = makeDeps({ runId: "t-throw", scenario: "selftest.throw" });

  // RN intercepta los Error de JS con ErrorUtils y el proceso no muere, así
  // que el handler nativo de `uncaught` no los ve (medido en dispositivo).
  // El escenario lanza dentro del try del runner: js_error + verdict crash.
  await runHeadlessOnce(h.deps);

  const regs = h.registros();
  assert.deepEqual(fases(regs), ["boot", "throwing"]);
  assert.deepEqual(h.sleeps, [100], "throwing dura 100 ms antes del error (A11)");

  const err = regs.find((r) => r.ev === "js_error");
  assert.ok(err, "deja ev:js_error");
  assert.equal(err!.lvl, "error");
  assert.match(JSON.stringify(err!.data), /selftest\.throw/);

  assert.deepEqual(
    h.calls.verdicts.map((v) => v.outcome),
    ["crash"],
    "el veredicto es crash, escrito por el runner",
  );
  const verdict = regs[regs.length - 1];
  assert.equal(verdict.ev, "verdict");
  assert.equal((verdict.data as { outcome: string }).outcome, "crash");
});

test("selftest.block: fija blocking y recién después bloquea 30 s con busy-wait de reloj, sin ceder el control", async () => {
  const h = makeDeps({ runId: "t-block", scenario: "selftest.block" });
  await runHeadlessOnce(h.deps);

  const regs = h.registros();
  assert.deepEqual(fases(regs), ["boot", "blocking"]);
  assert.deepEqual(h.calls.setPhase, ["boot", "blocking"], "el último hb llevará jsPhase:\"blocking\" (S5)");

  assert.equal(h.sleeps.length, 0, "no usó la espera cooperativa: el bloqueo es sincrónico");
  assert.ok(h.wallConsumido() >= 30000, "el reloj del busy-wait consumió los 30 s completos");

  const penultimo = regs[regs.length - 2];
  assert.equal(penultimo.ev, "phase");
  assert.equal((penultimo.data as { name: string }).name, "blocking", "ningún registro entre la fase blocking y el fin");
  assert.deepEqual(h.calls.verdicts, [{ outcome: "ok", dataJson: "{}" }]);
});

test("selftest.kill: fase killing y hardKill(), sin veredicto propio (A12)", async () => {
  const h = makeDeps({ runId: "t-kill", scenario: "selftest.kill" });
  await runHeadlessOnce(h.deps);

  const regs = h.registros();
  assert.deepEqual(fases(regs), ["boot", "killing"]);
  assert.equal(h.calls.hardKill, 1, "hardKill() una vez");
  assert.deepEqual(h.calls.verdicts, [], "en dispositivo el proceso muere antes del veredicto");
  const ultimo = regs[regs.length - 1];
  assert.equal(ultimo.ev, "phase");
  assert.equal((ultimo.data as { name: string }).name, "killing");
});

test("selftest.slow: 600 s en tramos de 100 ms con un ev:log cada 1000 ms (A11)", async () => {
  const h = makeDeps({ runId: "t-slow", scenario: "selftest.slow" });
  await runHeadlessOnce(h.deps);

  const regs = h.registros();
  assert.deepEqual(fases(regs), ["boot", "slow"]);
  assert.ok(h.sleeps.every((ms) => ms === 100), "duerme en tramos de 100 ms");
  assert.equal(h.sleeps.length, 6000, "6000 tramos de 100 ms = 600 s");

  const logs = regs.filter((r) => r.ev === "log");
  assert.equal(logs.length, 600, "un log por cada 1000 ms");
  const monos = logs.map((r) => r.mono);
  assert.equal(monos[0], 1000);
  assert.equal(monos[monos.length - 1], 600000);
  for (let i = 1; i < monos.length; i++) {
    assert.equal(monos[i] - monos[i - 1], 1000, "el seq de JS avanza cada 1000 ms");
  }
});

test("escenario desconocido: js_error estructurado con errInfo y veredicto crash (A10/A12)", async () => {
  const h = makeDeps({ runId: "t-fantasma", scenario: "selftest.fantasma" });
  await runHeadlessOnce(h.deps);

  const regs = h.registros();
  const jsError = regs.find((r) => r.ev === "js_error");
  assert.ok(jsError, "emite ev:js_error");
  assert.deepEqual(Object.keys(jsError!.data as object), ["name", "message", "code", "inner"], "data = errInfo (S11)");

  assert.equal(h.calls.verdicts.length, 1);
  assert.equal(h.calls.verdicts[0].outcome, "crash");
  assert.deepEqual(JSON.parse(h.calls.verdicts[0].dataJson), jsError!.data, "el dataJson del crash es el mismo errInfo");
  const verdict = regs[regs.length - 1];
  assert.deepEqual(verdict.data, { outcome: "crash" });
});
