/**
 * Runner headless (T5): corre el escenario pedido por el módulo nativo.
 *
 * Flujo (A1, A10, A11, A12): al arrancar el JS, `takePendingRequest()` UNA
 * vez; sin request no hace nada (arranque manual desde el launcher). Con
 * request emite `ev:"request"` y `ev:"js_boot"`, corre el escenario y cierra
 * con `setVerdict`. Cada fase se emite como `ev:"phase"` con `data:{name}` y
 * además se fija con `setPhase(name)` para el heartbeat (A6).
 *
 * Errores (A12): un error de escenario atrapado acá es `ev:"js_error"` con
 * `errInfo` + `setVerdict("crash", ...)`; `ev:"uncaught"` lo emite SÓLO el
 * handler nativo, por eso `selftest.throw` escapa por `setTimeout` (fuera de
 * todo try/catch de este módulo). El veredicto es dueño único en el nativo
 * (A12): si ya existe, el nativo ignora al segundo.
 *
 * El único serializador es `record.ts` (A3): este módulo produce las líneas
 * con `rec.emit(...)` y las escribe con `VioletaObs.append(line)`. No hay IO
 * ni serialización propia acá.
 *
 * `selftest.nojs` NO está en la tabla: lo corta Kotlin antes de evaluar el
 * bundle (A13); si igual llegara un request con ese nombre, cae en el camino
 * de "escenario desconocido" (`js_error` + crash).
 */

import { errInfo, makeRecorder, type Ev } from "./record.ts";
import { nanScenarios, relojDelSistema, type NanDeps } from "./scenarios-nan.ts";
import { crearMemoriaKey } from "../nan/key.ts";
import type { StreamPiAi } from "../nan/cliente.ts";
import { VioletaObs, type VioletaObsModule } from "./obs.ts";

// ---------------------------------------------------------------------------
// Tiempos de A11 (tabla de fases por escenario)
// ---------------------------------------------------------------------------

const WORK_MS = 1000;
const P1_MS = 1000;
const P2_MS = 1000;
const HOLD_MS = 15000;
/** "verdict ok a los ~17100 ms": 100 ms después de `done` (17000). */
const VERDICT_OK_EXTRA_MS = 100;
const THROW_DELAY_MS = 100;
/** `selftest.block` bloquea el hilo 30 s (A11). */
export const BLOCK_MS = 30000;
/** `selftest.slow`: 600 s en tramos de 100 ms, un `ev:"log"` cada 1000 ms. */
const SLOW_TOTAL_MS = 600000;
const SLOW_TRAMO_MS = 100;
const SLOW_LOG_CADA_MS = 1000;

// ---------------------------------------------------------------------------
// Dependencias inyectables (tests: mocks; dispositivo: módulo nativo real)
// ---------------------------------------------------------------------------

export interface RunnerDeps {
  /** Módulo nativo; default el singleton de `obs.ts`. */
  obs: VioletaObsModule;
  /**
   * Reloj monotónico nativo (A3): base de `mono` en los registros Y del que
   * dependen los tiempos de fase que ven los tests con reloj simulado.
   * Default `VioletaObs.mono()`.
   */
  mono(): number;
  /**
   * Reloj del busy-wait de `selftest.block` (default `Date.now()`). Es reloj
   * de pared a propósito: el bloqueo debe ser un spin de CPU contra el reloj,
   * nunca una espera cooperativa (A11, S3, S5).
   */
  wall(): number;
  /** Espera cooperativa entre fases (default `setTimeout`). */
  sleep(ms: number): Promise<void>;
  /**
   * Dependencias del motor NaN (A9). La app las completa con `expo/fetch`, el
   * almacén seguro y el adaptador real de pi-ai; los tests inyectan dobles.
   */
  nan: NanDeps;
}

export function defaultDeps(): RunnerDeps {
  return {
    obs: VioletaObs,
    mono: () => VioletaObs.mono(),
    wall: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    // Sin dispositivo: almacén vacío, sin fetch real y un stream que falla si
    // alguien intenta usarlo. La app reemplaza las tres cosas en `App.tsx`.
    nan: {
      fetchImpl: globalThis.fetch as unknown as NanDeps["fetchImpl"],
      almacenKey: crearMemoriaKey(null),
      streamPiAi: ((() => {
        throw new Error("streamPiAi no inyectado: la app debe pasar el adaptador de pi-ai");
      }) as unknown) as StreamPiAi,
      reloj: relojDelSistema(),
    },
  };
}

// ---------------------------------------------------------------------------
// Errores de JS fuera del runner (requisito 6: toda falla deja artefacto)
// ---------------------------------------------------------------------------

let globalHandlerInstalado = false;

/**
 * Un `Error` no atrapado en JS **no** llega al handler nativo de excepción:
 * React Native lo intercepta con `ErrorUtils` (y muestra la pantalla roja),
 * así que el proceso sigue vivo y `VioletaCore` nunca escribe `uncaught`.
 * Medido en dispositivo: `selftest.throw` daba `wedged razon=js` (exit 5) en
 * vez de `crash` (exit 3). Este handler escribe `js_error` + veredicto
 * `crash` ANTES de delegar en el handler que ya existía, para que ni el
 * redbox ni el comportamiento de desarrollo cambien.
 */
export function installGlobalErrorHandler(deps: RunnerDeps = defaultDeps()): void {
  if (globalHandlerInstalado) return;
  globalHandlerInstalado = true;
  const utilidades = (globalThis as { ErrorUtils?: {
    getGlobalHandler?: () => (e: unknown, fatal?: boolean) => void;
    setGlobalHandler?: (h: (e: unknown, fatal?: boolean) => void) => void;
  } }).ErrorUtils;
  if (utilidades?.setGlobalHandler === undefined) return;
  const previo = utilidades.getGlobalHandler?.();
  utilidades.setGlobalHandler((error, fatal) => {
    try {
      const info = errInfo(error);
      const rec = makeRecorder({ mono: deps.mono });
      deps.obs.setVerdict("crash", JSON.stringify(info));
      deps.obs.append(rec.emit("js_error", info, "error"));
      deps.obs.append(rec.emit("verdict", { outcome: "crash" }));
    } catch {
      // sin módulo nativo no hay artefacto posible; no se enmascara el error
    }
    previo?.(error, fatal);
  });
}

// ---------------------------------------------------------------------------
// Escenarios de autoprueba (A11, nombres y tiempos exactos)
// ---------------------------------------------------------------------------

export interface ScenarioCtx {
  /** Fija la fase: `setPhase(name)` para el heartbeat + `ev:"phase"` (A6/A10). */
  fase(name: string): void;
  sleep(ms: number): Promise<void>;
  /** Emite un registro JS arbitrario de la tabla cerrada de A10. */
  emitir(ev: Ev, data?: unknown): void;
  /** Bloquea el hilo sincrónicamente: busy-wait de reloj, no cede el event loop. */
  bloquear(ms: number): void;
  /** Muerte inmediata del proceso (A11): `Process.killProcess(myPid)`. */
  hardKill(): void;
}

/**
 * `selftest.throw` termina en un `Error` NO atrapado: `ev:"uncaught"` y el
 * veredicto crash los emite el handler nativo (A12), no este módulo. El
 * throw va dentro de un timer para escapar del try/catch del dispatcher y de
 * la cadena de promesas del escenario.
 */
function busyWait(ms: number, wall: () => number): void {
  const inicio = wall();
  while (wall() - inicio < ms) {
    // spin de reloj: bloqueo real del hilo (S3/S5); sin await, sin timers.
  }
}

/** Resultado del escenario: "ok" cierra con veredicto; "dying" no emite veredicto propio. */
type ScenarioOutcome = "ok" | "dying";
export type ScenarioFn = (ctx: ScenarioCtx) => Promise<ScenarioOutcome>;

const SCENARIOS: Record<string, ScenarioFn> = {
  "selftest.ok": async (ctx) => {
    ctx.fase("boot");
    ctx.fase("work");
    await ctx.sleep(WORK_MS);
    ctx.fase("done");
    return "ok";
  },

  "selftest.phases": async (ctx) => {
    ctx.fase("boot");
    ctx.fase("p1"); // a los 0 ms, dura 1000
    await ctx.sleep(P1_MS);
    ctx.fase("p2"); // a los 1000 ms, dura 1000
    await ctx.sleep(P2_MS);
    ctx.fase("hold"); // de 2000 a 17000 ms: 15000 exactos (ventana de S10)
    await ctx.sleep(HOLD_MS);
    ctx.fase("done"); // a los 17000 ms
    await ctx.sleep(VERDICT_OK_EXTRA_MS);
    return "ok"; // verdict ok a los ~17100 ms
  },

  "selftest.throw": async (ctx) => {
    ctx.fase("boot");
    ctx.fase("throwing");
    await ctx.sleep(THROW_DELAY_MS);
    // Medido en dispositivo: React Native intercepta los Error de JS con
    // ErrorUtils (redbox) y el proceso NO muere, así que el handler nativo de
    // excepción nunca los ve. Por eso el Error se lanza DENTRO del dispatcher:
    // el catch del runner escribe `js_error` + veredicto `crash` (exit 3).
    // `uncaught` sigue siendo exclusivo de crashes nativos (A12).
    throw new Error("selftest.throw: error de JS esperado");
  },

  "selftest.block": async (ctx) => {
    ctx.fase("boot");
    ctx.fase("blocking");
    // Recién DESPUÉS de fijar la fase bloquea (A11: el último hb lleva
    // jsPhase:"blocking"). Busy-wait de reloj: NO cede el event loop.
    ctx.bloquear(BLOCK_MS);
    return "ok";
  },

  "selftest.kill": async (ctx) => {
    ctx.fase("boot");
    ctx.fase("killing");
    ctx.hardKill();
    return "dying"; // en dispositivo no llega acá; sin veredicto propio
  },

  "selftest.slow": async (ctx) => {
    ctx.fase("boot");
    ctx.fase("slow");
    // Sin estos logs el seq de JS se congelaría y A8.6 daría "wedged razon=js"
    // en vez de "timeout" (A11).
    const tramos = SLOW_TOTAL_MS / SLOW_TRAMO_MS;
    const cada = SLOW_LOG_CADA_MS / SLOW_TRAMO_MS;
    for (let i = 1; i <= tramos; i++) {
      await ctx.sleep(SLOW_TRAMO_MS);
      if (i % cada === 0) ctx.emitir("log", { ms: i * SLOW_TRAMO_MS });
    }
    return "ok";
  },

  // "selftest.nojs" no existe acá: lo atiende Kotlin en MainActivity (A13).
};

// ---------------------------------------------------------------------------
// Punto de entrada
// ---------------------------------------------------------------------------

/**
 * Toma el request pendiente una vez y corre el escenario. Devuelve `false`
 * si no había request (arranque manual desde el launcher: no emite nada).
 *
 * Review punto 6: TODO el cuerpo vive dentro del try —también
 * takePendingRequest y los append de `request`/`js_boot`— para que cualquier
 * falla del runner deje artefacto (`js_error` con errInfo + verdict crash).
 * Si el propio try/catch no puede escribir (el módulo nativo tampoco
 * responde), la promesa rechaza y App.tsx intenta el veredicto una vez más.
 */
export async function runHeadlessOnce(deps: RunnerDeps = defaultDeps()): Promise<boolean> {
  const rec = makeRecorder({ mono: deps.mono });
  const append = (line: string): void => {
    deps.obs.append(line);
  };

  let tuvoRequest = false;
  try {
    const request = deps.obs.takePendingRequest();
    if (request === null) return false;
    tuvoRequest = true;

    // A13: `selftest.nojs` modela "el runner no arrancó". El JS evalúa pero
    // no emite NADA (ni request ni js_boot), que es lo que el driver lee como
    // `absent razon=js_ausente`. No se puede saltar la evaluación del bundle
    // sin romper el ciclo de vida de la Activity (SuperNotCalledException).
    if (request.scenario === "selftest.nojs") return true;

    append(rec.emit("request", { runId: request.runId, scenario: request.scenario }));
    append(rec.emit("js_boot", {}));

    const ctx: ScenarioCtx = {
      fase: (name) => {
        deps.obs.setPhase(name);
        append(rec.emit("phase", { name }));
      },
      sleep: (ms) => deps.sleep(ms),
      emitir: (ev, data) => append(rec.emit(ev, data)),
      bloquear: (ms) => busyWait(ms, deps.wall),
      hardKill: () => deps.obs.hardKill(),
    };

    // A9: los escenarios de NaN se esparcen acá; el driver no cambia.
    const escenario = { ...SCENARIOS, ...nanScenarios(deps.nan) }[request.scenario];
    if (escenario === undefined) {
      throw new Error(`escenario desconocido: ${JSON.stringify(request.scenario)}`);
    }
    const outcome = await escenario(ctx);
    if (outcome === "ok") {
      deps.obs.setVerdict("ok", "{}");
      append(rec.emit("verdict", { outcome: "ok" }));
    }
  } catch (err) {
    const info = errInfo(err);
    deps.obs.setVerdict("crash", JSON.stringify(info));
    append(rec.emit("js_error", info, "error"));
    append(rec.emit("verdict", { outcome: "crash" }));
  }
  return tuvoRequest;
}
