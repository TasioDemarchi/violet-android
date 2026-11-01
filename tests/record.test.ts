import { test } from "node:test";
import assert from "node:assert/strict";
import { EV_VALUES, LVL_VALUES, makeRecorder, parseNdjson } from "../src/harness/record.ts";

test("S4: la línea lleva las claves en el orden t,mono,src,lvl,ev,phase,data, sin seq, sin espacios ni saltos", () => {
  const rec = makeRecorder({ mono: () => 4242 });
  const line = rec.emit("js_boot");

  assert.equal(
    Object.keys(JSON.parse(line)).join(","),
    "t,mono,src,lvl,ev,phase,data",
    "orden de claves exacto de A3 (sin seq: lo antepone Kotlin)",
  );
  assert.equal(line, JSON.stringify(JSON.parse(line)), "sin espacios estructurales");
  assert.ok(!line.includes("\n"), "una línea NDJSON por registro, sin salto interno");
  assert.ok(!line.includes("seq"), "seq no lo produce JS");
  assert.equal(line[0], "{");
});

test("mono sale del reloj inyectado, nunca de Date.now()/performance.now(); t sí lo pone JS", () => {
  let llamadas = 0;
  const rec = makeRecorder({
    mono: () => {
      llamadas++;
      return 98765;
    },
  });
  const r = JSON.parse(rec.emit("log", { a: 1 }));

  assert.equal(r.mono, 98765, "mono = reloj inyectado, exacto");
  assert.equal(llamadas, 1, "una llamada al reloj por registro");
  // Date.now() acá daría ~1.7e12; si mono viniera del reloj de pared el test de arriba ya falló.
  assert.ok(Math.abs(r.t - Date.now()) < 5000, "t = Date.now() de JS");
  assert.equal(r.src, "js");
  assert.equal(r.lvl, "info", "lvl default info");
  assert.deepEqual(r.data, { a: 1 });
});

test("sin data el registro lleva data:{}", () => {
  const rec = makeRecorder({ mono: () => 1 });
  assert.deepEqual(JSON.parse(rec.emit("js_boot")).data, {});
});

test("phase: la fase vigente al emitir; para ev:'phase' coincide con data.name (A10)", () => {
  const rec = makeRecorder({ mono: () => 1 });

  const antes = JSON.parse(rec.emit("request", { runId: "r", scenario: "s" }));
  assert.equal(antes.phase, "-", "sin fase previa: convención '-'");

  const p = JSON.parse(rec.emit("phase", { name: "boot" }));
  assert.equal(p.phase, "boot");
  assert.deepEqual(p.data, { name: "boot" });

  const despues = JSON.parse(rec.emit("log", { x: 1 }));
  assert.equal(despues.phase, "boot", "los registros siguientes llevan la fase vigente");

  rec.emit("phase", { name: "work" });
  assert.equal(JSON.parse(rec.emit("log")).phase, "work");
});

test("ev:'phase' exige data.name string y falla fuerte si falta", () => {
  const rec = makeRecorder({ mono: () => 1 });
  assert.throws(() => rec.emit("phase"), /phase/);
  assert.throws(() => rec.emit("phase", {}), /phase/);
  assert.throws(() => rec.emit("phase", { name: 42 }), /phase/);
});

test("tabla cerrada de ev de A10: 11 valores exactos y nada más", () => {
  assert.deepEqual([...EV_VALUES], [
    "native_init",
    "clock",
    "request",
    "js_boot",
    "phase",
    "log",
    "js_error",
    "uncaught",
    "nojs_forced",
    "verdict",
    "hb",
  ]);
  assert.equal(EV_VALUES.length, 11);
});

test("lvl cerrado: info|warn|error", () => {
  assert.deepEqual([...LVL_VALUES], ["info", "warn", "error"]);
});

test("ev o lvl fuera de tabla es error del programador: falla fuerte con mensaje claro", () => {
  const rec = makeRecorder({ mono: () => 1 });
  assert.throws(() => rec.emit("no_existe" as never), /ev fuera de la tabla cerrada/);
  assert.throws(() => rec.emit("log", {}, "verbose" as never), /lvl fuera de la tabla cerrada/);
});

test("el reloj inyectado que no devuelve un número finito falla fuerte", () => {
  const rec = makeRecorder({ mono: () => Number.NaN });
  assert.throws(() => rec.emit("log"), /mono no finito/);
});

test("parseNdjson: lee líneas con seq antepuesto (splice de Kotlin), salta vacías y tolera CRLF", () => {
  const rec = makeRecorder({ mono: () => 7 });
  const l1 = rec.emit("js_boot");
  const l2 = rec.emit("phase", { name: "work" });
  // Reconstruyo las líneas reales del archivo como las arma Kotlin: {"seq":n,<línea de JS sin la llave inicial>
  const texto = `{"seq":1,${l1.slice(1)}\n{"seq":2,${l2.slice(1)}\n\n`;
  const rs = parseNdjson(texto);

  assert.equal(rs.length, 2);
  assert.equal(rs[0].seq, 1);
  assert.equal(rs[0].mono, 7);
  assert.equal(rs[0].ev, "js_boot");
  assert.equal(rs[1].seq, 2);
  assert.equal(rs[1].phase, "work");

  assert.equal(parseNdjson(l1 + "\r\n").length, 1, "CRLF tolerado");
  assert.equal(parseNdjson("").length, 0);
  assert.equal(parseNdjson("\n\n").length, 0);
});

test("parseNdjson: falla con número de línea si hay JSON inválido", () => {
  assert.throws(() => parseNdjson('{"seq":1}\n{nope\n'), /línea 2/);
  assert.throws(() => parseNdjson("[1,2]\n"), /no es un registro de objeto/);
});

test("el default de mono no toca Date.now(): sin reloj inyectado fuera del dispositivo falla con mensaje claro", () => {
  // En Node ESM no existe require/react-native, así que el default debe
  // fallar fuerte explicando que hay que inyectar el reloj.
  const rec = makeRecorder();
  assert.throws(() => rec.emit("js_boot"), /VioletaObs\.mono\(\) no está disponible/);
});
