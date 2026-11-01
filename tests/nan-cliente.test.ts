// Tests del cliente NaN (T3) — corren en Node puro, sin red ni timers largos:
// `fetch` y `stream` son fakes inyectados (S4, S6, S7).
import assert from "node:assert/strict";
import { test } from "node:test";

import { crearCliente, mensajeTimeout } from "../src/nan/cliente.ts";
import type { FetchInyectable, StreamPiAi } from "../src/nan/cliente.ts";
import { NAN_FALTA_KEY, crearMemoriaKey } from "../src/nan/key.ts";
import { MODELO_NAN } from "../src/nan/modelo.ts";

const KEY_PRUEBA = "key-prueba-nan";

function fetchFalso(): FetchInyectable {
  return async () => ({ ok: true, status: 200, body: {} });
}

function fetchExplosivo(): FetchInyectable {
  return async () => {
    throw new Error("el cliente no debió pedir");
  };
}

interface Llamada {
  model: unknown;
  messages: unknown;
  options: Record<string, unknown>;
}

test("S4: concatena los text_delta en orden, el texto final es la concatenación exacta y hay 1 request", async () => {
  const llamadas: Llamada[] = [];
  const stream: StreamPiAi = async function* (model, messages, options) {
    llamadas.push({ model, messages, options: options as Record<string, unknown> });
    yield { type: "text_delta", delta: "Hola" };
    yield { type: "text_delta", delta: ", mundo" };
    yield { type: "text_delta", delta: "!" };
    yield { type: "done" };
  };
  const mensajes = [{ role: "user", content: "decí hola" }];
  const cliente = crearCliente({ fetch: fetchFalso(), almacen: crearMemoriaKey(KEY_PRUEBA), stream });

  const resultado = await cliente.enviar(mensajes);

  assert.equal(resultado.texto, "Hola, mundo!");
  assert.equal(resultado.requests, 1);
  assert.deepEqual(resultado.toolCalls, []);
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].model, MODELO_NAN);
  assert.deepEqual(llamadas[0].messages, mensajes);
});

test("la key viaja en options.apiKey y el fetch inyectado llega tal cual en options.fetch", async () => {
  const fetchFalsoRef = fetchFalso();
  const llamadas: Llamada[] = [];
  const stream: StreamPiAi = async function* (_model, _messages, options) {
    llamadas.push({ model: _model, messages: _messages, options: options as Record<string, unknown> });
    yield { type: "done" };
  };
  const cliente = crearCliente({ fetch: fetchFalsoRef, almacen: crearMemoriaKey(KEY_PRUEBA), stream });

  await cliente.enviar([]);

  const options = llamadas[0].options;
  assert.equal(options.apiKey, KEY_PRUEBA);
  assert.equal(options.fetch, fetchFalsoRef);
  assert.ok(options.signal instanceof AbortSignal);
});

test("sin key lanza el literal exacto y corta antes de cualquier pedido", async () => {
  let pedidos = 0;
  const stream: StreamPiAi = async function* () {
    pedidos += 1;
    yield { type: "done" };
  };
  const cliente = crearCliente({ fetch: fetchExplosivo(), almacen: crearMemoriaKey(null), stream });

  await assert.rejects(
    cliente.enviar([]),
    (error: unknown) => error instanceof Error && error.message === NAN_FALTA_KEY,
  );
  assert.equal(pedidos, 0);
});

test("S6: con timeoutMs: 50 aborta la señal y rechaza con mensajeTimeout(50); el literal de 45 s es exacto", async () => {
  const senales: AbortSignal[] = [];
  const stream: StreamPiAi = async function* (_model, _messages, options) {
    senales.push((options as { signal: AbortSignal }).signal);
    await new Promise(() => {}); // nunca produce eventos
    yield { type: "done" };
  };
  const cliente = crearCliente({ fetch: fetchFalso(), almacen: crearMemoriaKey(KEY_PRUEBA), stream, timeoutMs: 50 });

  await assert.rejects(
    cliente.enviar([]),
    (error: unknown) => error instanceof Error && error.message === mensajeTimeout(50),
  );
  assert.equal(senales[0].aborted, true);
  assert.equal(mensajeTimeout(45000), "NaN tardó demasiado (45 s). Probá de nuevo.");
  assert.equal(mensajeTimeout(50), "NaN tardó demasiado (0 s). Probá de nuevo.");
});

test("S7: un 500 produce 'NaN respondió con error: 500' y el cuerpo no aparece en el mensaje", async () => {
  const stream: StreamPiAi = async function* () {
    yield { type: "text_delta", delta: "parcial " };
    yield { type: "error", error: { status: 500, body: "cuerpo-secreto-que-no-debe-fugar" } };
  };
  const cliente = crearCliente({ fetch: fetchFalso(), almacen: crearMemoriaKey(KEY_PRUEBA), stream });

  await assert.rejects(cliente.enviar([]), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "NaN respondió con error: 500");
    assert.ok(!error.message.includes("cuerpo-secreto-que-no-debe-fugar"));
    return true;
  });
});

test("S6: el abort externo corta el consumo y no se sigue agregando texto", async () => {
  const externo = new AbortController();
  let abrirPuerta: () => void = () => {};
  let continuar: () => void = () => {};
  const enPuerta = new Promise<void>((res) => {
    abrirPuerta = res;
  });
  const puerta = new Promise<void>((res) => {
    continuar = res;
  });
  let llegoAlFinal = false;
  let cerrado = false;
  const stream: StreamPiAi = async function* () {
    try {
      yield { type: "text_delta", delta: "antes " };
      abrirPuerta();
      await puerta;
      yield { type: "text_delta", delta: "DESPUES-DEL-ABORT" };
      llegoAlFinal = true;
    } finally {
      cerrado = !llegoAlFinal;
    }
  };
  const cliente = crearCliente({ fetch: fetchFalso(), almacen: crearMemoriaKey(KEY_PRUEBA), stream });

  const envio = cliente.enviar([], { signal: externo.signal });
  await enPuerta; // el stream ya entregó "antes " y quedó esperando
  externo.abort(new Error("corte-externo"));
  continuar(); // el stream produce un delta más; el cliente no debe agregarlo

  await assert.rejects(
    envio,
    (error: unknown) => error instanceof Error && error.message === "corte-externo",
  );
  assert.equal(cerrado, true, "el cliente cerró el iterador en vez de seguir consumiendo");
});

test("S4: cada text_delta se entrega en el momento por onDelta, antes de terminar", async () => {
  const orden: string[] = [];
  const stream: StreamPiAi = async function* () {
    yield { type: "text_delta", delta: "a" };
    yield { type: "text_delta", delta: "b" };
    yield { type: "done" };
  };
  const cliente = crearCliente({ fetch: fetchFalso(), almacen: crearMemoriaKey(KEY_PRUEBA), stream });

  const resultado = await cliente.enviar([], {
    onDelta: (d) => orden.push(`${d}@${orden.length}`),
  });

  assert.deepEqual(orden, ["a@0", "b@1"], "llegan en orden y mientras el stream corre");
  assert.equal(resultado.texto, "ab");
});
