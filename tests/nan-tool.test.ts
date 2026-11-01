// Test de la herramienta `hora_actual` y del bucle acotado de `conversar` (A6/A7/S5).
// Cliente falso, sin red: `enviar` devuelve respuestas enlatadas y registra lo recibido.
import test from "node:test";
import assert from "node:assert/strict";

import {
  NOMBRE_HORA,
  TOOL_HORA,
  ejecutarHora,
  conversar,
  type Reloj,
} from "../src/nan/herramientas.ts";

interface EnvioFalso {
  texto: string;
  requests: number;
  toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
}

interface EnvioRegistrado {
  mensajes: unknown[];
  opciones:
    | { signal?: AbortSignal; herramientas?: unknown; onDelta?: (delta: string) => void }
    | undefined;
}

function clienteFalso(
  respuestas: EnvioFalso[],
): {
  cliente: {
    enviar(
      mensajes: unknown[],
      opciones?: { signal?: AbortSignal; herramientas?: unknown; onDelta?: (delta: string) => void },
    ): Promise<EnvioFalso>;
  };
  registrados: EnvioRegistrado[];
} {
  const registrados: EnvioRegistrado[] = [];
  return {
    registrados,
    cliente: {
      async enviar(mensajes, opciones) {
        registrados.push({ mensajes, opciones });
        const respuesta = respuestas[registrados.length - 1];
        if (respuesta === undefined) {
          throw new Error(`envío inesperado número ${registrados.length}`);
        }
        // El cliente real entrega cada delta mientras corre (S4); el doble
        // hace lo mismo para que la costura `onDelta` quede ejercitada.
        opciones?.onDelta?.(respuesta.texto);
        return respuesta;
      },
    },
  };
}

const RELOJ_FIJO: Reloj = {
  ahora: () => new Date("2025-06-01T12:00:00.000Z"),
  zona: () => "America/Argentina/Buenos_Aires",
};

test("ejecutarHora con reloj inyectado devuelve iso, zona del reloj y epochMs", () => {
  const resultado = ejecutarHora({}, RELOJ_FIJO);
  assert.equal(resultado.iso, "2025-06-01T12:00:00.000Z");
  assert.equal(resultado.zona, "America/Argentina/Buenos_Aires");
  assert.equal(resultado.epochMs, Date.parse("2025-06-01T12:00:00.000Z"));
});

test("ejecutarHora con zona explícita usa la zona pedida, no la del reloj", () => {
  const resultado = ejecutarHora({ zona: "Europe/Madrid" }, RELOJ_FIJO);
  assert.equal(resultado.zona, "Europe/Madrid");
  assert.equal(resultado.iso, "2025-06-01T12:00:00.000Z");
});

test("conversar: dos envíos, el texto final contiene el iso y el tool result viaja con el epochMs (S5)", async () => {
  const iso = "2025-06-01T12:00:00.000Z";
  const epochMs = Date.parse(iso);
  const { cliente, registrados } = clienteFalso([
    {
      texto: "",
      requests: 1,
      toolCalls: [{ id: "call_1", name: NOMBRE_HORA, arguments: {} }],
    },
    { texto: `Ahora mismo son las ${iso}.`, requests: 1, toolCalls: [] },
  ]);
  const mensajes: unknown[] = [{ role: "user", content: "¿Qué hora es? Usá la herramienta hora_actual." }];
  const deltas: string[] = [];

  const resultado = await conversar({
    cliente,
    mensajes,
    reloj: RELOJ_FIJO,
    onDelta: (delta) => deltas.push(delta),
  });

  // S5: exactamente 2 requests, y el dato no inventable viaja de vuelta.
  assert.equal(resultado.requests, 2);
  assert.equal(resultado.rondas, 1);
  assert.ok(resultado.texto.includes(iso), "el texto final debe contener el iso devuelto por la herramienta");

  // No hay tercer envío.
  assert.equal(registrados.length, 2);

  // El segundo envío recibió los mensajes con el turno del asistente y el tool result.
  const mensajesSegundo = registrados[1]!.mensajes;
  const asistente = mensajesSegundo.find(
    (m) => (m as { role?: string }).role === "assistant",
  ) as { tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
  assert.ok(asistente, "falta el turno del asistente con el tool call");
  assert.equal(asistente.tool_calls.length, 1);
  assert.equal(asistente.tool_calls[0]!.id, "call_1");
  assert.equal(asistente.tool_calls[0]!.type, "function");
  assert.equal(asistente.tool_calls[0]!.function.name, NOMBRE_HORA);
  assert.deepEqual(JSON.parse(asistente.tool_calls[0]!.function.arguments), {});

  const tool = mensajesSegundo.find(
    (m) => (m as { role?: string }).role === "tool",
  ) as { role: string; tool_call_id: string; content: string };
  assert.ok(tool, "falta el mensaje role:tool");
  assert.equal(tool.tool_call_id, "call_1");
  const resultadoHora = JSON.parse(tool.content) as { iso: string; zona: string; epochMs: number };
  assert.equal(resultadoHora.iso, iso);
  assert.equal(resultadoHora.zona, "America/Argentina/Buenos_Aires");
  assert.equal(resultadoHora.epochMs, epochMs, "el epochMs del tool result debe ser el correcto");

  // onDelta se llamó con el texto del envío y la concatenación es el texto final.
  assert.equal(deltas.join(""), resultado.texto);

  // Los envíos llevaron la herramienta por defecto.
  for (const registro of registrados) {
    assert.deepEqual(registro.opciones?.herramientas, [TOOL_HORA]);
  }
});

test("conversar: sin rondas disponibles responde el error y NO vuelve a pedir (A7)", async () => {
  const { cliente, registrados } = clienteFalso([
    {
      texto: "",
      requests: 1,
      toolCalls: [{ id: "call_1", name: NOMBRE_HORA, arguments: {} }],
    },
    {
      texto: "",
      requests: 1,
      toolCalls: [{ id: "call_2", name: NOMBRE_HORA, arguments: {} }],
    },
  ]);
  const mensajes: unknown[] = [{ role: "user", content: "¿Qué hora es?" }];

  const resultado = await conversar({
    cliente,
    mensajes,
    reloj: RELOJ_FIJO,
  });

  // Tope de 2 requests por mensaje: no hay tercer envío.
  assert.equal(registrados.length, 2);
  assert.equal(resultado.requests, 2);
  assert.equal(resultado.rondas, 1);

  const mensajesUltimo = registrados[1]!.mensajes;
  const errores = mensajesUltimo.filter(
    (m) => (m as { tool_call_id?: string }).tool_call_id === "call_2",
  ) as Array<{ tool_call_id: string; content: string }>;
  assert.equal(errores.length, 1, "la segunda llamada no debe ejecutarse");
  assert.equal(errores[0]!.content, '{"error":"máximo una herramienta por mensaje"}');
});
