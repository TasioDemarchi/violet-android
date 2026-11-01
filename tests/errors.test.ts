import { test } from "node:test";
import assert from "node:assert/strict";
import { errInfo, makeRecorder, secret } from "../src/harness/record.ts";

test("S11: errInfo produce {name,message,code,inner} en ese orden", () => {
  const info = errInfo(new Error("boom"));
  assert.equal(Object.keys(info).join(","), "name,message,code,inner");
  assert.equal(info.name, "Error");
  assert.equal(info.message, "boom");
  assert.equal(info.code, null);
  assert.equal(info.inner, null);
});

test("S11: message recortado a 300 caracteres exactos", () => {
  const largo = "x".repeat(1000);
  const info = errInfo(new Error(largo));
  assert.equal(info.message.length, 300);
  const corto = errInfo(new Error("corto"));
  assert.equal(corto.message, "corto");
});

test("errInfo conserva code cuando es string", () => {
  const e = new Error("fallo de fs");
  (e as { code?: string }).code = "EACCES";
  assert.equal(errInfo(e).code, "EACCES");
  assert.equal(errInfo(new Error("sin code")).code, null);
});

test("errInfo: inner por cause, recursivo y también recortado", () => {
  const inner = new Error("y".repeat(400));
  const outer = new Error("outer", { cause: inner });
  const info = errInfo(outer);
  assert.equal(info.inner?.name, "Error");
  assert.equal(info.inner?.message.length, 300);
  assert.equal(info.inner?.inner, null);
});

test("errInfo: cadenas de cause profundas no revientan la pila", () => {
  let e: Error = new Error("base");
  for (let i = 0; i < 50; i++) e = new Error(`nivel${i}`, { cause: e });
  let actual: ReturnType<typeof errInfo> | null = errInfo(e);
  let niveles = 0;
  while (actual) {
    niveles++;
    actual = actual.inner;
  }
  assert.ok(niveles <= 11, `tope de profundidad respetado, dio ${niveles}`);
});

test("errInfo acepta valores lanzados que no son Error", () => {
  const info = errInfo("boom de string");
  assert.equal(info.name, "string");
  assert.equal(info.message, "boom de string");
});

test("S11: el valor marcado con secret() aparece como *** en cualquier profundidad, sin romper el JSON", () => {
  const rec = makeRecorder({ mono: () => 5 });
  const data = {
    apiKey: secret("sk-supersecreto"),
    anidado: { lista: [1, secret("otro-secreto"), { profundo: secret("secreto-profundo") }] },
    visible: "texto normal",
  };
  const line = rec.emit("log", data);
  const r = JSON.parse(line); // el JSON no se rompe

  assert.equal(r.data.apiKey, "***");
  assert.equal(r.data.anidado.lista[1], "***");
  assert.equal(r.data.anidado.lista[2].profundo, "***");
  assert.equal(r.data.visible, "texto normal");
  assert.equal(r.data.anidado.lista[0], 1);
  assert.ok(!line.includes("sk-supersecreto"), "el valor original no viaja en la línea");
  assert.ok(!line.includes("secreto-profundo"));
});

test("S11: secret() como data raíz también se redacta", () => {
  const rec = makeRecorder({ mono: () => 5 });
  const r = JSON.parse(rec.emit("log", secret("valor-raíz")));
  assert.equal(r.data, "***");
});

test("S11: el registro js_error lleva errInfo serializado con las claves name,message,code,inner", () => {
  const rec = makeRecorder({ mono: () => 5 });
  const line = rec.emit("js_error", errInfo(new Error("fallo js")), "error");
  const r = JSON.parse(line);
  assert.equal(r.lvl, "error");
  assert.equal(r.ev, "js_error");
  assert.equal(Object.keys(r.data).join(","), "name,message,code,inner");
  assert.equal(r.data.message, "fallo js");
});
