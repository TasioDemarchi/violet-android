// Cliente del provider NaN (T3, A4/A5/A8/A11).
//
// Este módulo NO importa nada de Expo ni de React Native: `fetch`, `stream` y el
// almacén de la key entran por parámetro. Eso es lo que permite que `node --test`
// corra el cliente entero sin dispositivo y sin los SDKs de Node que arrastra pi-ai.
import { leerKeyObligatoria, type AlmacenKey } from "./key.ts";
import { MODELO_NAN, type Modelo } from "./modelo.ts";

export type { Modelo };

/** Adaptador de streaming de pi-ai: `streamSimple(model, messages, options)`. */
export type StreamPiAi = (
  model: unknown,
  messages: unknown,
  options: unknown,
) => AsyncIterable<EventoStream>;

export interface EventoStream {
  type: string;
  delta?: string;
  toolCall?: { id?: string; name?: string; arguments?: unknown };
  error?: unknown;
}

/** `fetch` inyectable: `expo/fetch` en la app, un doble en tests y escenarios. */
export type FetchInyectable = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; body: unknown }>;

export interface OpcionesCliente {
  fetch: FetchInyectable;
  almacen: AlmacenKey;
  stream: StreamPiAi;
  /** A8: inyectable para que un test no tenga que esperar 45 s. */
  timeoutMs?: number;
}

export interface ResultadoEnvio {
  /** Concatenación exacta de los `text_delta`, en el orden del stream (S4). */
  texto: string;
  /** A7: un "turno" es un request al provider. */
  requests: number;
  toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
}

export const TIMEOUT_MS = 45000;

/** Literal de timeout (A8). `ms` se muestra en segundos redondeados. */
export function mensajeTimeout(ms: number): string {
  return `NaN tardó demasiado (${Math.round(ms / 1000)} s). Probá de nuevo.`;
}

export interface OpcionesEnvio {
  signal?: AbortSignal;
  herramientas?: unknown;
  /** S4: cada `text_delta` se entrega acá EN EL MOMENTO, para poder mostrarlo. */
  onDelta?: (delta: string) => void;
}

function statusDeError(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function comoError(motivo: unknown, porDefecto: string): Error {
  if (motivo instanceof Error) return motivo;
  return new Error(porDefecto);
}

export function crearCliente(op: OpcionesCliente): {
  enviar(mensajes: unknown[], opciones?: OpcionesEnvio): Promise<ResultadoEnvio>;
} {
  const timeoutMs = op.timeoutMs ?? TIMEOUT_MS;

  return {
    async enviar(mensajes, opciones = {}) {
      // A3: la key se lee por envío, nunca se cachea en el módulo, y si falta
      // se corta ANTES de cualquier request.
      const apiKey = await leerKeyObligatoria(op.almacen);

      const control = new AbortController();
      const externa = opciones.signal;
      const propagar = (): void => control.abort(externa?.reason);
      if (externa !== undefined) {
        if (externa.aborted) propagar();
        else externa.addEventListener("abort", propagar, { once: true });
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      let rechazarPorAborto: (error: Error) => void = () => {};

      const vencido = new Promise<never>((_, rechazar) => {
        timer = setTimeout(() => {
          const error = new Error(mensajeTimeout(timeoutMs));
          control.abort(error);
          rechazar(error);
        }, timeoutMs);
      });

      // Aborto externo: rechaza con la razón del abort ("corte-externo" en el test).
      const abortado = new Promise<never>((_, rechazar) => {
        rechazarPorAborto = rechazar;
      });
      const alAbortar = (): void => {
        rechazarPorAborto(comoError(control.signal.reason, "envío abortado"));
      };
      control.signal.addEventListener("abort", alAbortar, { once: true });

      const iterador = op.stream(MODELO_NAN, mensajes, {
        apiKey,
        fetch: op.fetch,
        signal: control.signal,
        ...(opciones.herramientas === undefined ? {} : { tools: opciones.herramientas }),
      })[Symbol.asyncIterator]();

      const texto: string[] = [];
      const toolCalls: ResultadoEnvio["toolCalls"] = [];

      const consumir = async (): Promise<ResultadoEnvio> => {
        for (;;) {
          const paso = await iterador.next();
          if (paso.done === true) break;
          const evento = paso.value;
          if (evento.type === "text_delta" && typeof evento.delta === "string") {
            texto.push(evento.delta);
            opciones.onDelta?.(evento.delta);
          } else if (evento.type === "toolcall_end" && evento.toolCall !== undefined) {
            toolCalls.push({
              id: String(evento.toolCall.id ?? ""),
              name: String(evento.toolCall.name ?? ""),
              arguments: evento.toolCall.arguments ?? {},
            });
          } else if (evento.type === "error") {
            // A11/S7: el cuerpo del provider puede llevar datos del request,
            // así que al mensaje sólo va el status; el body no se registra.
            const status = statusDeError(evento.error);
            throw new Error(
              status === null ? "NaN respondió con error" : `NaN respondió con error: ${status}`,
            );
          }
        }
        return { texto: texto.join(""), requests: 1, toolCalls };
      };

      const trabajo = consumir();
      // Si gana el timeout o el abort, `consumir()` queda pendiente: se ignora
      // en vez de dejar una promesa rechazada sin dueño.
      trabajo.catch(() => {});

      try {
        return await Promise.race([trabajo, vencido, abortado]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        control.signal.removeEventListener("abort", alAbortar);
        if (externa !== undefined) externa.removeEventListener("abort", propagar);
        // Cierra el iterador del provider: no se sigue consumiendo después de
        // un abort (S6). El cierre se espera con un tope corto: un generador
        // suspendido en un await interno no se puede interrumpir, y esperarlo
        // sin tope colgaría el envío (y al test) para siempre.
        try {
          const cierre = iterador.return?.(undefined) ?? Promise.resolve();
          await Promise.race([
            Promise.resolve(cierre).catch(() => undefined),
            new Promise<void>((resolver) => setTimeout(resolver, 100)),
          ]);
        } catch {
          // el generador ya estaba cerrado o roto: no cambia el resultado
        }
      }
    },
  };
}
