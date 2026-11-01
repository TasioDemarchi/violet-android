// Herramienta `hora_actual` y bucle acotado de conversación (A6/A7/S5).
//
// Como `cliente.ts`, este módulo no importa nada de Expo: el reloj entra
// inyectado (`Reloj`) y el proveedor de respuestas es el cliente que llega por
// parámetro. Eso permite que `node --test` corra todo sin dispositivo.
import type { ResultadoEnvio } from "./cliente.ts";

export const NOMBRE_HORA = "hora_actual";

/** Definición de la herramienta en la forma que espera el provider (JSON Schema). */
export const TOOL_HORA: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
} = {
  name: NOMBRE_HORA,
  description:
    "Devuelve la hora actual del dispositivo. Parámetro opcional `zona`: identificador IANA (por ejemplo America/Argentina/Buenos_Aires).",
  parameters: {
    type: "object",
    properties: {
      zona: {
        type: "string",
        description: "Zona horaria IANA opcional; si falta se usa la del dispositivo.",
      },
    },
  },
};

/** Reloj inyectable (A6: `Date` e `Intl` no se tocan desde el módulo). */
export interface Reloj {
  ahora(): Date;
  zona(): string;
}

/** A6: `{zona?}` → `{iso, zona, epochMs}`, ejecutada en el proceso de la app. */
export function ejecutarHora(
  args: { zona?: string },
  reloj: Reloj,
): { iso: string; zona: string; epochMs: number } {
  const fecha = reloj.ahora();
  return {
    iso: fecha.toISOString(),
    zona: args?.zona !== undefined ? args.zona : reloj.zona(),
    epochMs: fecha.getTime(),
  };
}

export interface OpcionesConversacion {
  cliente: {
    enviar(
      mensajes: unknown[],
      opciones?: {
        signal?: AbortSignal;
        herramientas?: unknown;
        onDelta?: (delta: string) => void;
      },
    ): Promise<ResultadoEnvio>;
  };
  mensajes: unknown[];
  reloj: Reloj;
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
  /** Default `[TOOL_HORA]`. */
  herramientas?: unknown;
  /** A7: máximo una ronda de herramienta por mensaje. Default 1. */
  maxRondasHerramienta?: number;
}

export interface ResultadoConversacion {
  texto: string;
  requests: number;
  rondas: number;
}

const ERROR_SIN_RONDAS = JSON.stringify({
  error: "máximo una herramienta por mensaje",
});

/** Turno del asistente con el tool call, formato OpenAI-compatible. */
function turnoAsistente(toolCall: { id: string; name: string; arguments: unknown }): unknown {
  return {
    role: "assistant",
    tool_calls: [
      {
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments),
        },
      },
    ],
  };
}

function turnoTool(id: string, content: string): unknown {
  return { role: "tool", tool_call_id: id, content };
}

/** Ejecuta el bucle acotado (A7): enviar → (tool result) → enviar. */
export async function conversar(op: OpcionesConversacion): Promise<ResultadoConversacion> {
  const herramientas = op.herramientas ?? [TOOL_HORA];
  const topeRondas = op.maxRondasHerramienta ?? 1;
  let rondasRestantes = topeRondas;
  let requests = 0;
  let rondas = 0;
  let texto = "";

  for (;;) {
    const respuesta = await op.cliente.enviar(op.mensajes, {
      signal: op.signal,
      herramientas,
      onDelta: op.onDelta,
    });
    requests += respuesta.requests;

    if (respuesta.texto.length > 0) {
      texto += respuesta.texto;
      // El cliente ya entrega cada delta en el momento (S4); si además
      // llega el texto completo del envío, no se reemite para no duplicar.
      void respuesta.texto;
    }

    if (respuesta.toolCalls.length === 0) break;

    const deHora = respuesta.toolCalls.filter((tc) => tc.name === NOMBRE_HORA);
    if (rondasRestantes > 0 && deHora.length === respuesta.toolCalls.length) {
      op.mensajes.push(...respuesta.toolCalls.map(turnoAsistente));
      rondasRestantes -= 1;
      for (const tc of respuesta.toolCalls) {
        const resultado = ejecutarHora(
          (tc.arguments ?? {}) as { zona?: string },
          op.reloj,
        );
        op.mensajes.push(turnoTool(tc.id, JSON.stringify(resultado)));
        rondas += 1;
      }
      continue;
    }

    // Sin rondas disponibles (o herramienta no ejecutable): se responde el
    // error y se cierra el mensaje, sin un tercer request (A7).
    op.mensajes.push(...respuesta.toolCalls.map(turnoAsistente));
    op.mensajes.push(...respuesta.toolCalls.map((tc) => turnoTool(tc.id, ERROR_SIN_RONDAS)));
    break;
  }

  return { texto, requests, rondas };
}
