// S8: la key y el contenido de la respuesta no llegan al NDJSON del arnés.
import assert from "node:assert/strict";
import test from "node:test";

import { makeRecorder } from "../src/harness/record.ts";
import { secret } from "../src/harness/record.ts";

const KEY_CENTINELA = "key-sentinela-no-real";
const RESPUESTA = "respuesta-centinela-de-cuarenta-caract";
const SEGUNDA_MITAD = RESPUESTA.slice(Math.floor(RESPUESTA.length / 2));

test("S8: ni la key ni la segunda mitad de la respuesta aparecen en un registro de escenario", () => {
  const rec = makeRecorder({ mono: () => 1000 });
  // Lo que emiten los escenarios de NaN: nombre de paso, milisegundos y tamaño.
  const lineas = [
    rec.emit("phase", { name: "stream" }),
    rec.emit("log", { evt: "nan.sent", ms: 1200, n: RESPUESTA.length }),
    rec.emit("log", { evt: "nan.first_delta", ms: 30, n: 1 }),
    rec.emit("log", { evt: "nan.error", ms: 40, n: 0, status: 500 }),
    rec.emit("verdict", { outcome: "ok" }),
  ];
  for (const linea of lineas) {
    assert.ok(!linea.includes(KEY_CENTINELA), "la key se filtró al registro");
    assert.ok(!linea.includes(SEGUNDA_MITAD), "la respuesta se filtró al registro");
  }
});

test("S8: el cuerpo del 500 tampoco viaja, y secret() lo tapa si alguien lo intenta", () => {
  const rec = makeRecorder({ mono: () => 1000 });
  const linea = rec.emit("log", { evt: "nan.error", ms: 1, n: 0, status: 500 });
  assert.ok(!linea.includes("cuerpo-secreto"));
  const conSecret = rec.emit("log", { evt: "nan.error", ms: 1, n: 0, cuerpo: secret("cuerpo-secreto") });
  assert.ok(!conSecret.includes("cuerpo-secreto"));
  assert.ok(conSecret.includes("***"));
});
