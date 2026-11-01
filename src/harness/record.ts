import { VioletaObs } from "./obs.ts";
/**
 * Frontera de serialización del arnés Violeta (A3).
 *
 * Este es el ÚNICO serializador de registros JS. Produce la línea NDJSON
 * completa MENOS `seq`, con las claves en este orden exacto:
 *   t, mono, src, lvl, ev, phase, data
 * Kotlin antepone `seq` por splice dentro del lock del writer; por eso la
 * línea que devuelve `emit()` no lleva `seq`, ni `\n`, ni espacios
 * estructurales. La escritura la hace Kotlin (`VioletaObs.append(line)`):
 * acá no hay IO de archivos.
 *
 * `mono` no lo calcula JS: sale del reloj inyectado (`makeRecorder({ mono })`,
 * default `VioletaObs.mono()` = `SystemClock.elapsedRealtime()`), nunca de
 * `Date.now()` ni `performance.now()`. `t` en cambio sí lo pone JS
 * (`Date.now()`) y es el único tiempo que JS elige.
 *
 * Tablas cerradas (A10): `ev` tiene exactamente los 11 valores de la tabla y
 * `lvl` es `info | warn | error`. Un valor fuera de tabla es un error del
 * programador: `emit()` falla fuerte.
 */

export const EV_VALUES = [
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
] as const;
export type Ev = (typeof EV_VALUES)[number];

export const LVL_VALUES = ["info", "warn", "error"] as const;
export type Lvl = (typeof LVL_VALUES)[number];

/**
 * Fase cuando todavía no se emitió ningún `ev:"phase"` (convención "sin
 * valor" del arnés; debe coincidir con lo que Kotlin usa en sus registros
 * nativos, que ocurren antes de que exista JS).
 */
const SIN_FASE = "-";

/** Largo máximo del `message` en `errInfo` (S11). */
const MESSAGE_MAX = 300;
/** Tope de profundidad de la cadena `inner`, contra cadenas circulares. */
const INNER_MAX_DEPTH = 10;

// ---------------------------------------------------------------------------
// secret(): redacción por wrap (S11)
// ---------------------------------------------------------------------------

const SECRET: unique symbol = Symbol("violeta.secret");

/** Envuelve un valor para que se serialice como `***` en cualquier profundidad. */
export interface Secret {
  readonly [SECRET]: true;
  readonly value: unknown;
}

/** Marca `value` para que el serializador lo escriba como `***`. */
export function secret(value: unknown): Secret {
  return { [SECRET]: true, value };
}

export function isSecret(value: unknown): value is Secret {
  return typeof value === "object" && value !== null && SECRET in value;
}

// ---------------------------------------------------------------------------
// errInfo(): error estructurado (S11, A10 fila js_error)
// ---------------------------------------------------------------------------

export interface ErrInfo {
  name: string;
  message: string;
  code: string | null;
  inner: ErrInfo | null;
}

function recortar(message: string): string {
  return message.length <= MESSAGE_MAX ? message : message.slice(0, MESSAGE_MAX);
}

/**
 * Convierte cualquier valor lanzado en el `data` estructurado de
 * `ev:"js_error"`: `{name, message, code, inner}` con `message` recortado a
 * 300 caracteres. El `inner` se toma de `cause` (o `.inner`) y se recorta
 * igual, con tope de profundidad.
 */
export function errInfo(err: unknown, depth = 0): ErrInfo {
  const esError = err instanceof Error;
  const name = esError ? err.name : typeof err;
  const message = esError ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  const fuente = err as { cause?: unknown; inner?: unknown } | null;
  const innerBruto = fuente?.cause ?? fuente?.inner;
  const inner =
    innerBruto !== undefined && innerBruto !== null && depth < INNER_MAX_DEPTH
      ? errInfo(innerBruto, depth + 1)
      : null;
  return { name, message: recortar(message), code: typeof code === "string" ? code : null, inner };
}

// ---------------------------------------------------------------------------
// makeRecorder(): serializador único (A3)
// ---------------------------------------------------------------------------

export interface RecorderOptions {
  /** Reloj monotónico nativo; default `VioletaObs.mono()`. */
  mono?: () => number;
}

export interface Recorder {
  /**
   * Serializa un registro JS y devuelve la línea NDJSON sin `seq` ni `\n`
   * (listo para `VioletaObs.append(line)`). Falla fuerte si `ev` o `lvl`
   * están fuera de sus tablas cerradas.
   *
   * Para `ev:"phase"` exige `data.name` string y fija la fase vigente (A10:
   * en ese registro `phase` coincide con `data.name`); los demás registros
   * llevan la última fase fijada, o `"-"` si todavía no hubo ninguna.
   */
  emit(ev: Ev, data?: unknown, lvl?: Lvl): string;
}

/**
 * Default de A3: `VioletaObs.mono()` (SystemClock.elapsedRealtime() vía el
 * Expo Module), resuelto en el momento de la llamada y nunca al importar.
 * `obs.ts` no toca nada nativo hasta que se invoca, así que `node --test`
 * (sin dispositivo) puede importar este módulo e inyectar su propio reloj.
 */
function defaultMono(): number {
  return VioletaObs.mono();
}

export function makeRecorder(options: RecorderOptions = {}): Recorder {
  const mono = options.mono ?? defaultMono;
  let fase = SIN_FASE;

  return {
    emit(ev, data, lvl = "info") {
      if (!EV_VALUES.includes(ev)) {
        throw new Error(
          `ev fuera de la tabla cerrada de A10: ${JSON.stringify(ev)}. Valores válidos: ${EV_VALUES.join(", ")}`,
        );
      }
      if (!LVL_VALUES.includes(lvl)) {
        throw new Error(
          `lvl fuera de la tabla cerrada: ${JSON.stringify(lvl)}. Valores válidos: ${LVL_VALUES.join(", ")}`,
        );
      }
      if (ev === "phase") {
        const nombre = (data as { name?: unknown } | null | undefined)?.name;
        if (typeof nombre !== "string" || nombre.length === 0) {
          throw new Error(`ev:"phase" exige data:{name:string}, recibí ${JSON.stringify(data) ?? String(data)}`);
        }
        fase = nombre;
      }
      const monoValor = mono();
      if (typeof monoValor !== "number" || !Number.isFinite(monoValor)) {
        throw new Error(`el reloj inyectado devolvió un mono no finito: ${JSON.stringify(monoValor) ?? String(monoValor)}`);
      }
      // Orden de claves contractual (A3/S4): la inserción define el orden.
      const registro = {
        t: Date.now(),
        mono: monoValor,
        src: "js",
        lvl,
        ev,
        phase: fase,
        data: data === undefined ? {} : data,
      };
      return JSON.stringify(registro, (_clave, valor) => (isSecret(valor) ? "***" : valor));
    },
  };
}

// ---------------------------------------------------------------------------
// parseNdjson(): lectura de log.ndjson / heartbeat.ndjson desde el host (A5)
// ---------------------------------------------------------------------------

/** Registro leído del archivo real: incluye el `seq` que antepone Kotlin. */
export interface HarnessRecord {
  seq: number;
  t: number;
  mono: number;
  src: string;
  lvl: string;
  ev: string;
  phase: string;
  data: unknown;
}

/**
 * Parser NDJSON tolerante: salta líneas vacías (incluida la última), tolera
 * LF/CR-LF (A5) y falla con el número de línea si algo no es JSON. No
 * valida esquema: eso lo hace el consumidor (T6).
 */
export function parseNdjson(text: string): HarnessRecord[] {
  const registros: HarnessRecord[] = [];
  const lineas = text.split("\n");
  for (let i = 0; i < lineas.length; i++) {
    const cruda = lineas[i];
    const linea = cruda.endsWith("\r") ? cruda.slice(0, -1) : cruda;
    if (linea.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(linea);
    } catch (err) {
      const causa = err instanceof Error ? err.message : String(err);
      throw new Error(`línea ${i + 1} no es JSON válido: ${causa}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`línea ${i + 1} no es un registro de objeto: ${linea.slice(0, 120)}`);
    }
    registros.push(parsed as HarnessRecord);
  }
  return registros;
}
