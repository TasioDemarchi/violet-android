// Escenarios de NaN para el arnés (A9/A10/A11).
//
// Viven acá y se esparcen en el mapa `SCENARIOS` del runner: el driver de host
// ya resuelve por nombre (`--scenario nan.stream`), así que no se toca.
//
// Reglas de registro (A10/A11): no hay `ev` nuevos; se usan `phase`, `log` y
// `verdict`. Un `log` de estos escenarios lleva únicamente `{evt, ms, n}` (y
// `status` cuando aplica): números y nombre de paso, nunca el texto del modelo
// ni la key.
import { crearCliente, mensajeTimeout, type StreamPiAi } from "../nan/cliente.ts";
import { crearMemoriaKey, NAN_FALTA_KEY, type AlmacenKey } from "../nan/key.ts";
import { conversar, TOOL_HORA, type Reloj } from "../nan/herramientas.ts";
import type { ScenarioCtx, ScenarioFn } from "./runner.ts";

export interface NanDeps {
  /** `expo/fetch` en la app; stub en tests. Nunca se registra. */
  fetchImpl: Parameters<typeof crearCliente>[0]["fetch"];
  /** `SecureStoreKey` en la app; memoria vacía en `nan.sin-key`. */
  almacenKey: AlmacenKey;
  /** Adaptador real (`streamSimple`) en la app; generador de prueba en tests. */
  streamPiAi: StreamPiAi;
  /** Reloj de `hora_actual` (A6). */
  reloj: Reloj;
}

const PEDIDO_STREAM = "Decí hola en una palabra.";

export const PEDIDO_TOOL = "¿Qué hora es? Usá la herramienta hora_actual.";

function relojDelSistema(): Reloj {
  return {
    ahora: () => new Date(),
    zona: () => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "desconocida";
      } catch {
        return "desconocida";
      }
    },
  };
}

export function nanScenarios(deps: NanDeps): Record<string, ScenarioFn> {
  const cliente = (almacen: AlmacenKey, stream: StreamPiAi = deps.streamPiAi) =>
    crearCliente({ fetch: deps.fetchImpl, almacen, stream });

  const registrar = (
    ctx: ScenarioCtx,
    evt: string,
    n: number,
    status?: number,
  ): void => {
    ctx.emitir("log", status === undefined ? { evt, ms: Date.now(), n } : { evt, ms: Date.now(), n, status });
  };

  return {
    // S4 en dispositivo: streaming real contra NaN, un solo request.
    "nan.stream": async (ctx) => {
      ctx.fase("key");
      const cli = cliente(deps.almacenKey);
      ctx.fase("stream");
      let deltas = 0;
      const enviado = Date.now();
      const resultado = await cli.enviar([{ role: "user", content: PEDIDO_STREAM }], {
        onDelta: () => {
          deltas += 1;
          if (deltas === 1) registrar(ctx, "nan.first_delta", 1);
        },
      });
      registrar(ctx, "nan.sent", resultado.texto.length, Date.now() - enviado);
      if (resultado.requests !== 1) {
        throw new Error(`nan.stream: requests=${resultado.requests}, se esperaba 1`);
      }
      if (resultado.texto.trim().length === 0) {
        throw new Error("nan.stream: la respuesta vino vacía");
      }
      if (deltas < 2) {
        throw new Error(`nan.stream: ${deltas} delta(s), se esperaban al menos 2`);
      }
      ctx.fase("done");
      return "ok";
    },

    // S5 en dispositivo: la herramienta corre acá y su dato vuelve al modelo.
    "nan.tool": async (ctx) => {
      ctx.fase("key");
      const cli = cliente(deps.almacenKey);
      ctx.fase("tool");
      const ejecutados: Array<ReturnType<typeof TOOL_HORA extends never ? never : never>> = [];
      void ejecutados;
      const esperado = deps.reloj.ahora().toISOString();
      const enviado = Date.now();
      const resultado = await conversar({
        cliente: cli,
        mensajes: [{ role: "user", content: PEDIDO_TOOL }],
        reloj: deps.reloj,
        herramientas: [TOOL_HORA],
      });
      registrar(ctx, "nan.tool", resultado.texto.length, Date.now() - enviado);
      if (resultado.requests !== 2) {
        throw new Error(`nan.tool: requests=${resultado.requests}, se esperaban 2 (dos turnos)`);
      }
      if (resultado.rondas !== 1) {
        throw new Error(`nan.tool: rondas=${resultado.rondas}, se esperaba 1`);
      }
      // El dato sólo puede estar ahí si la herramienta se ejecutó y el
      // resultado viajó de vuelta en el segundo request.
      const iso = esperado.slice(0, 13); // precisión de minutos: el reloj corre
      if (!resultado.texto.includes(iso) && !resultado.texto.includes(esperado)) {
        throw new Error(
          `nan.tool: la respuesta no menciona la hora de la herramienta (${iso}): ${resultado.texto.slice(0, 120)}`,
        );
      }
      ctx.fase("done");
      return "ok";
    },

    // Sin key: el cliente corta ANTES de cualquier request (S3/S11).
    "nan.sin-key": async (ctx) => {
      ctx.fase("key");
      let pedidos = 0;
      const stream: StreamPiAi = async function* () {
        pedidos += 1;
        yield { type: "done" };
      };
      const cli = cliente(crearMemoriaKey(null), stream);
      let mensaje = "";
      try {
        await cli.enviar([{ role: "user", content: PEDIDO_STREAM }]);
      } catch (error) {
        mensaje = error instanceof Error ? error.message : String(error);
      }
      if (mensaje !== NAN_FALTA_KEY) {
        throw new Error(`nan.sin-key: mensaje inesperado: ${JSON.stringify(mensaje)}`);
      }
      if (pedidos !== 0) {
        throw new Error(`nan.sin-key: hubo ${pedidos} request(s) antes de cortar`);
      }
      ctx.fase("done");
      return "ok";
    },

    // Error HTTP: se propaga el status, nunca el cuerpo (S7/A11).
    "nan.http-error": async (ctx) => {
      ctx.fase("stream");
      const stream: StreamPiAi = async function* () {
        yield { type: "text_delta", delta: "parcial " };
        yield { type: "error", error: { status: 500, body: "cuerpo-secreto-del-provider" } };
      };
      const cli = cliente(crearMemoriaKey("key-de-prueba"), stream);
      let mensaje = "";
      try {
        await cli.enviar([{ role: "user", content: PEDIDO_STREAM }]);
      } catch (error) {
        mensaje = error instanceof Error ? error.message : String(error);
      }
      if (mensaje !== "NaN respondió con error: 500") {
        throw new Error(`nan.http-error: mensaje inesperado: ${JSON.stringify(mensaje)}`);
      }
      if (mensaje.includes("cuerpo-secreto-del-provider")) {
        throw new Error("nan.http-error: el cuerpo del provider se filtró al mensaje");
      }
      registrar(ctx, "nan.error", 0, 500);
      ctx.fase("done");
      return "ok";
    },
  };
}

export { relojDelSistema, mensajeTimeout };
