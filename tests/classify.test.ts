/**
 * T6: clasificador puro de A8 (filas 1..7 + precondiciones de A7) y stdout
 * de A9, sin adb, sin red, sin procesos. Tiempos explícitos en todos los
 * fixtures: nada de Date.now().
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  EXIT_CODES,
  formatClockLine,
  formatEstadoLine,
  formatFinalLine,
  parseEstadoLine,
  parseFinalLine,
  type Observacion,
  type Precondition,
} from "../tools/classify.ts";

// ---------------------------------------------------------------------------
// Fixtures: reloj explícito, tomado del ejemplo de A9
// ---------------------------------------------------------------------------

const CLOCK_T = 1762000000123;

/** Corrida sana al segundo 1: hb y seq de JS al día, sin verdict, sin timeout. */
function base(extra: Partial<Observacion> = {}): Observacion {
  return {
    precondicion: null,
    verdict: null,
    ahoraMono: CLOCK_T + 1000,
    clockT: CLOCK_T,
    jsBoot: true,
    pidVivo: true,
    ultimoHbT: CLOCK_T + 500,
    ultimoJsSeq: 41,
    ultimoJsSeqT: CLOCK_T + 900,
    timeoutAgotado: false,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// A8: una fixture por fila, en orden y mutuamente excluyente
// ---------------------------------------------------------------------------

test("A8.1: verdict ok → estado=ok razon=- exit 0", () => {
  const r = classify(base({ verdict: { outcome: "ok", dataName: null } }));
  assert.deepEqual(r, { estado: "ok", razon: "-" });
  assert.equal(EXIT_CODES[r.estado], 0);
});

test("A8.2: verdict crash → estado=crash razon=data.name exit 3; sin dataName, razon=-", () => {
  const r = classify(base({ verdict: { outcome: "crash", dataName: "RangeError" } }));
  assert.deepEqual(r, { estado: "crash", razon: "RangeError" });
  assert.equal(EXIT_CODES[r.estado], 3);

  const sinNombre = classify(base({ verdict: { outcome: "crash" } }));
  assert.deepEqual(sinNombre, { estado: "crash", razon: "-" });
});

test("A8.3: sin verdict, ≥15000 ms desde clock sin js_boot → absent/js_ausente exit 7", () => {
  const r = classify(base({ jsBoot: false, pidVivo: false, ahoraMono: CLOCK_T + 15000 }));
  assert.deepEqual(r, { estado: "absent", razon: "js_ausente" });
  assert.equal(EXIT_CODES[r.estado], 7);
});

test("A8.4: js_boot y pid muerto → dead/sin_pid exit 4, aunque el hb esté viejo", () => {
  const r = classify(base({ pidVivo: false, ultimoHbT: CLOCK_T - 2000 }));
  assert.deepEqual(r, { estado: "dead", razon: "sin_pid" });
  assert.equal(EXIT_CODES[r.estado], 4);
});

test("A8.5: pid vivo, hb más viejo que 3000 ms → wedged/process exit 5, aunque el seq js esté congelado", () => {
  const r = classify(
    base({ ultimoHbT: CLOCK_T - 2001, ultimoJsSeqT: CLOCK_T - 25000 }),
  );
  assert.deepEqual(r, { estado: "wedged", razon: "process" });
  assert.equal(EXIT_CODES[r.estado], 5);
});

test("A8.6: hb al día, seq de js sin avanzar en 20000 ms → wedged/js exit 5", () => {
  const r = classify(base({ ultimoJsSeqT: CLOCK_T - 20000 }));
  assert.deepEqual(r, { estado: "wedged", razon: "js" });
  assert.equal(EXIT_CODES[r.estado], 5);
});

test("A8.7: todo avanzando y timeout agotado → timeout/deadline exit 6", () => {
  const r = classify(base({ timeoutAgotado: true }));
  assert.deepEqual(r, { estado: "timeout", razon: "deadline" });
  assert.equal(EXIT_CODES[r.estado], 6);
});

test("EXIT_CODES: tabla exacta de exits por estado", () => {
  assert.deepEqual(EXIT_CODES, { ok: 0, env: 2, crash: 3, dead: 4, wedged: 5, timeout: 6, absent: 7 });
});

// ---------------------------------------------------------------------------
// A7/A8.0: una fixture por cada precondición → env, nunca dead
// ---------------------------------------------------------------------------

const PRECONDICIONES: Precondition["razon"][] = [
  "adb_ausente",
  "am_start_fallo",
  "run_dir_ausente",
  "uso_invalido",
];

for (const razon of PRECONDICIONES) {
  test(`A8.0: precondición ${razon} → estado=env exit 2, aun con verdict y js vivo`, () => {
    const r = classify(
      base({
        precondicion: { razon, detalle: "detalle de prueba" },
        verdict: { outcome: "ok", dataName: null },
      }),
    );
    assert.deepEqual(r, { estado: "env", razon });
    assert.equal(EXIT_CODES[r.estado], 2);
  });
}

// ---------------------------------------------------------------------------
// A9: round-trip de las tres formas de línea
// ---------------------------------------------------------------------------

test("línea de estado: ejemplo literal de A9 y round-trip", () => {
  const linea = formatEstadoLine({ s: 12, seq: 41, hb: 12, phase: "hold" });
  assert.equal(linea, "violeta: t=12.0s seq=41 hb=12 phase=hold estado=corriendo");
  assert.deepEqual(parseEstadoLine(linea), { s: 12, seq: 41, hb: 12, phase: "hold" });
});

test("línea de estado: datos faltantes van como '-' y el parseo los devuelve null", () => {
  const linea = formatEstadoLine({ s: 0.5, seq: null, hb: null, phase: null });
  assert.equal(linea, "violeta: t=0.5s seq=- hb=- phase=- estado=corriendo");
  assert.deepEqual(parseEstadoLine(linea), { s: 0.5, seq: null, hb: null, phase: null });
});

test("línea de estado: forma distinta (estado final, otra línea, vacía) → null", () => {
  assert.equal(parseEstadoLine("violeta: t=1.0s seq=1 hb=1 phase=boot estado=wedged"), null);
  assert.equal(parseEstadoLine("violeta: run r1 estado=ok razon=- evidencia=-"), null);
  assert.equal(parseEstadoLine(""), null);
});

test("línea final: ejemplo literal de A9 con comando en evidencia, round-trip", () => {
  const cmd = "adb exec-out run-as dev.tasio.violeta cat files/runs/s3-1762000000/log.ndjson";
  const linea = formatFinalLine({ runId: "s3-1762000000", estado: "wedged", razon: "js", evidencia: cmd });
  assert.equal(linea, `violeta: run s3-1762000000 estado=wedged razon=js evidencia=${cmd}`);
  assert.deepEqual(parseFinalLine(linea), {
    runId: "s3-1762000000",
    estado: "wedged",
    razon: "js",
    evidencia: cmd,
  });
});

test("línea final: evidencia=- parsea a null y formatea de vuelta igual", () => {
  const linea = formatFinalLine({ runId: "r1", estado: "ok", razon: "-", evidencia: null });
  assert.equal(linea, "violeta: run r1 estado=ok razon=- evidencia=-");
  assert.deepEqual(parseFinalLine(linea), {
    runId: "r1",
    estado: "ok",
    razon: "-",
    evidencia: null,
  });
});

test("línea final: razon=uso_invalido lleva runId=- y evidencia=- (A9)", () => {
  const linea = formatFinalLine({ runId: "-", estado: "env", razon: "uso_invalido", evidencia: null });
  assert.equal(linea, "violeta: run - estado=env razon=uso_invalido evidencia=-");
  assert.deepEqual(parseFinalLine(linea), {
    runId: "-",
    estado: "env",
    razon: "uso_invalido",
    evidencia: null,
  });
});

test("línea final: estado fuera de la tabla cerrada de A8 → null", () => {
  assert.equal(parseFinalLine("violeta: run r1 estado=corriendo razon=- evidencia=-"), null);
  assert.equal(parseFinalLine("violeta: run r1 estado=OK razon=- evidencia=-"), null);
});

test("líneas de reloj: literales de A9, pre y post", () => {
  assert.equal(formatClockLine("pre", 1762000000123), "violeta: clock host_pre=1762000000123");
  assert.equal(formatClockLine("post", 1762000000456), "violeta: clock host_post=1762000000456");
});
