#!/usr/bin/env node
/**
 * T6 (mitad de host): driver de corrida headless. Completa A7 (precondiciones
 * p1..p5), A5 (lectura incremental por exec-out/tail -c) y A9 (stdout literal:
 * dos marcas de reloj, una línea de estado por poll, una línea final).
 *
 * La decisión (filas 1..7 de A8) y el formato viven en tools/classify.ts;
 * acá sólo se recolecta la observación y se la pasa a classify().
 *
 * CLI: node tools/violeta-run.ts --scenario <nombre> --runId <id>
 *            [--timeout <s>] [--serial <id>] [--adb <path>]
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  classify,
  EXIT_CODES,
  formatClockLine,
  formatEstadoLine,
  formatFinalLine,
  type Estado,
  type Observacion,
  type Precondition,
} from "./classify.ts";
import { parseNdjson, type HarnessRecord } from "../src/harness/record.ts";

const PAQUETE = "dev.tasio.violeta";
const ACTIVITY = `${PAQUETE}/.MainActivity`;
const POLL_MS = 1000;
const FORCE_STOP_ESPERA_MS = 5000; // A7 p2
const RUN_DIR_ESPERA_MS = 10000; // A7 p4

// ---------------------------------------------------------------------------
// Único punto de contacto con adb
// ---------------------------------------------------------------------------

/**
 * Tope de todo comando adb: un adb colgado no puede congelar el driver
 * (review punto 3). `res.error` o `res.signal` son fallo de transporte:
 * reintento acotado (1 reintento) y si persiste se lanza FalloTransporte,
 * que main() convierte en `env` con exit 2. Nunca cuelga sin línea final.
 */
const ADB_TIMEOUT_MS = 15000;

class FalloTransporte extends Error {
  readonly detalle: string;

  constructor(detalle: string) {
    super(detalle);
    this.detalle = detalle;
  }
}

function run(cmd: string[]): { code: number; stdout: string; stderr: string } {
  let ultimoFallo = "";
  for (let intento = 0; intento < 2; intento++) {
    const res = spawnSync(cmd[0], cmd.slice(1), {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: ADB_TIMEOUT_MS,
    });
    if (res.error || res.signal) {
      ultimoFallo =
        `${cmd.join(" ")}: ` +
        (res.error
          ? String(res.error.message ?? res.error)
          : `muerto por señal ${res.signal} (timeout de ${ADB_TIMEOUT_MS} ms)`);
      continue; // 1 reintento y nada más
    }
    return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  }
  throw new FalloTransporte(`${ultimoFallo}; falló también tras el reintento`);
}

/** Resuelve el binario adb: --adb, si no $ANDROID_HOME, si no $HOME/Android/Sdk. */
function resolverAdb(explicito: string | undefined): string {
  if (explicito) return explicito;
  const sdk = process.env.ANDROID_HOME ?? join(homedir(), "Android", "Sdk");
  return join(sdk, "platform-tools", "adb");
}

// ---------------------------------------------------------------------------
// Argumentos (A7 p5)
// ---------------------------------------------------------------------------

interface Args {
  scenario?: string;
  runId?: string;
  timeout: number;
  serial?: string;
  adb?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { timeout: 60 };
  for (let i = 0; i < argv.length; i++) {
    const valor = (): string => argv[++i] ?? "";
    switch (argv[i]) {
      case "--scenario": args.scenario = valor(); break;
      case "--runId": args.runId = valor(); break;
      case "--timeout": args.timeout = Number(valor()); break;
      case "--serial": args.serial = valor(); break;
      case "--adb": args.adb = valor(); break;
      default: break; // flag desconocido: ignorado
    }
  }
  if (!Number.isFinite(args.timeout) || args.timeout <= 0) args.timeout = 60;
  return args;
}

const USO =
  "uso: node tools/violeta-run.ts --scenario <nombre> --runId <id> " +
  "[--timeout <s>] [--serial <id>] [--adb <path>]";

// ---------------------------------------------------------------------------
// Ayudas de observación
// ---------------------------------------------------------------------------

type Num = number | null;

function asNumero(v: unknown): Num {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asCadena(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function dormir(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Último registro que cumple `pred`, o null. */
function ultimo(regs: HarnessRecord[], pred: (r: HarnessRecord) => boolean): HarnessRecord | null {
  for (let i = regs.length - 1; i >= 0; i--) if (pred(regs[i])) return regs[i];
  return null;
}

function obsPrecondicion(p: Precondition): Observacion {
  return {
    precondicion: p,
    verdict: null,
    ahoraMono: 0,
    clockT: null,
    jsBoot: false,
    pidVivo: false,
    ultimoHbT: null,
    ultimoJsSeq: null,
    ultimoJsSeqT: null,
    timeoutAgotado: false,
  };
}

/** Fase reportada por un hb (A6/A10: vive sólo en data.jsPhase). */
function faseDeHb(r: HarnessRecord | null): string | null {
  if (!r) return null;
  return asCadena((r.data as { jsPhase?: unknown } | null | undefined)?.jsPhase);
}

/** `data.beat` de un hb (A6). */
function beatDeHb(r: HarnessRecord | null): Num {
  if (!r) return null;
  return asNumero((r.data as { beat?: unknown } | null | undefined)?.beat);
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // A7 p5: sin --runId o sin --scenario no se arranca nada (A9: runId "-").
  if (!args.scenario || !args.runId) {
    const faltan = [
      args.scenario ? null : "--scenario",
      args.runId ? null : "--runId",
    ].filter(Boolean) as string[];
    console.error(USO);
    console.error(`violeta-run: falta ${faltan.join(" y ")}`);
    console.log(
      formatFinalLine({ runId: "-", estado: "env", razon: "uso_invalido", evidencia: null }),
    );
    return EXIT_CODES.env;
  }
  const { scenario, runId } = args as { scenario: string; runId: string };

  const adbPath = resolverAdb(args.adb);
  const adbCmd = (...cmd: string[]): string[] => [
    adbPath,
    ...(args.serial ? ["-s", args.serial] : []),
    ...cmd,
  ];

  /** Toda precondición imprime la línea final (estado env, evidencia -) y exit 2. */
  const fallarPrecondicion = (p: Precondition): number => {
    console.error(`violeta-run: ${p.razon}: ${p.detalle}`);
    const { estado, razon } = classify(obsPrecondicion(p));
    console.log(formatFinalLine({ runId, estado, razon, evidencia: null }));
    return EXIT_CODES[estado];
  };

  // Review punto 3: el try envuelve todo lo que habla con adb. Un fallo de
  // transporte que persiste tras el reintento de run() se reporta como
  // precondición `env` con exit 2 y mensaje claro (razon adb_ausente: la
  // tabla cerrada de A7 no tiene un valor propio para "adb colgado", y para
  // el host es lo mismo). El driver nunca cuelga sin línea final.
  // A9: la evidencia vale `-` mientras el log no esté confirmado (p4).
  let evidencia: string | null = null;
  try {
    // Sin binario adb no hay p1: mensaje claro y adb_ausente.
    // `ls` de una ruta inexistente imprime "ls: <ruta>: No such file" por
    // stdout y adb devuelve 0 igual (medido en dispositivo), así que la
    // existencia se decide por la línea que coincide EXACTA con la ruta.
    const existeRemoto = (ruta: string): boolean => {
      const ls = run(adbCmd("exec-out", "run-as", PAQUETE, "ls", ruta));
      return ls.code === 0 && ls.stdout.split("\n").some((l) => l.trim() === ruta);
    };

    // A7 p6 (agregado tras la primera corrida real): reusar un `runId` mezcla
    // la evidencia de dos corridas en el mismo directorio y el verdict.json
    // viejo (O_EXCL, primero gana) puede devolver un `ok` FALSO. Nunca se
    // borra evidencia: se rechaza la corrida.
    // `exec-out` no corre un shell: `test` no existe como comando suelto y adb
    // devuelve 0 igual, así que la existencia se decide por la salida de `ls`
    // (misma técnica que p4).
    if (existeRemoto(`files/runs/${args.runId}/log.ndjson`)) {
      console.error(`violeta-run: runId_repetido: ya existe files/runs/${args.runId}/log.ndjson`);
      console.log(
        formatFinalLine({
          runId: args.runId,
          estado: "env",
          razon: "runid_repetido",
          evidencia: null,
        }),
      );
      return EXIT_CODES.env;
    }

    if (!existsSync(adbPath)) {
      return fallarPrecondicion({
        razon: "adb_ausente",
        detalle:
          `no existe el binario adb en ${adbPath} ` +
          "(definí ANDROID_HOME, o pasá --adb <path>)",
      });
    }

    // A7 p1: `adb get-state` ≠ device → adb_ausente.
    const estado = run(adbCmd("get-state"));
    if (estado.code !== 0 || estado.stdout.trim() !== "device") {
      return fallarPrecondicion({
        razon: "adb_ausente",
        detalle: `adb get-state devolvió ${estado.code} ${JSON.stringify(estado.stdout.trim())}; se esperaba "device"`,
      });
    }

    // A7 p2: force-stop y, a los 5 s, el proceso todavía vivo → am_start_fallo.
    const forceStop = run(adbCmd("shell", "am", "force-stop", PAQUETE));
    if (forceStop.code !== 0) {
      return fallarPrecondicion({
        razon: "am_start_fallo",
        detalle: `am force-stop falló (exit ${forceStop.code}): ${forceStop.stderr.trim()}`,
      });
    }
    await dormir(FORCE_STOP_ESPERA_MS);
    const pidTrasStop = run(adbCmd("shell", "pidof", PAQUETE));
    if (pidTrasStop.stdout.trim().length > 0) {
      return fallarPrecondicion({
        razon: "am_start_fallo",
        detalle: `el proceso sigue vivo 5 s después del force-stop (pidof: ${pidTrasStop.stdout.trim()})`,
      });
    }

    // A1/A9: el am start va entre las dos marcas de reloj; el --timeout y la
    // ventana de p4 se cuentan desde acá.
    console.log(formatClockLine("pre", Date.now()));
    const amStart = run(
      adbCmd(
        "shell", "am", "start", "-n", ACTIVITY,
        "--es", "violeta.scenario", scenario,
        "--es", "violeta.runId", runId,
      ),
    );
    console.log(formatClockLine("post", Date.now()));
    const inicioAmStart = Date.now();

    // A7 p3: salida de am start con Error: o Exception → am_start_fallo.
    const salidaAm = amStart.stdout + amStart.stderr;
    if (/Error:|Exception/.test(salidaAm)) {
      return fallarPrecondicion({
        razon: "am_start_fallo",
        detalle: `am start reportó un error: ${salidaAm.trim().split("\n")[0]}`,
      });
    }

    // A7 p4: files/runs/<runId>/log.ndjson debe existir a los 10 s del am start.
    const logRemoto = `files/runs/${runId}/log.ndjson`;
    let runDirOk = false;
    for (let esperado = 0; esperado <= RUN_DIR_ESPERA_MS; esperado += POLL_MS) {
      if (existeRemoto(logRemoto)) {
        runDirOk = true;
        break;
      }
      if (esperado < RUN_DIR_ESPERA_MS) await dormir(POLL_MS);
    }
    if (!runDirOk) {
      return fallarPrecondicion({
        razon: "run_dir_ausente",
        detalle: `${logRemoto} no apareció en los ${RUN_DIR_ESPERA_MS / 1000} s posteriores al am start`,
      });
    }

    // A9: la evidencia es ese cat literal, ejecutable tal cual (S9). p4 ya
    // confirmó que el archivo existe: la lleva toda línea final de acá en más.
    // A9: el comando de `evidencia=` tiene que ejecutarse tal cual, así que
    // lleva el mismo binario de adb que usó el driver (no `adb` a secas).
    const adbParaEvidencia = /\s/.test(adbPath) ? `"${adbPath}"` : adbPath;
    evidencia = `${adbParaEvidencia} exec-out run-as ${PAQUETE} cat ${logRemoto}`;

    // A5: lectura incremental, sin releer todo. Offset = bytes ya consumidos
    // (sólo líneas completas); el resto parcial queda en `pending` para la
    // próxima pasada.
    interface Lectura {
      offset: number;
      pending: string;
    }
    const leerIncremental = async (
      archivo: string,
      lectura: Lectura,
    ): Promise<HarnessRecord[]> => {
      const res = run(
        adbCmd("exec-out", "run-as", PAQUETE, "tail", "-c", `+${lectura.offset + 1}`,
          `files/runs/${runId}/${archivo}`),
      );
      if (res.code !== 0 || res.stdout.length === 0) return [];
      // `exec-out` mezcla el stderr del device en stdout: mientras el archivo
      // todavía no existe (primeros cientos de ms de la corrida) llega texto
      // como "tail: files/runs/...: No such file". El offset avanza por los
      // bytes crudos leídos (así el próximo tail no los repite) y sólo las
      // líneas que empiezan con `{` se parsean como registros.
      lectura.offset += Buffer.byteLength(res.stdout, "utf8");
      const combinado = lectura.pending + res.stdout;
      const ultimoNl = combinado.lastIndexOf("\n");
      if (ultimoNl === -1) {
        lectura.pending = combinado;
        return [];
      }
      const completo = combinado.slice(0, ultimoNl + 1);
      lectura.pending = combinado.slice(ultimoNl + 1);
      const lineas = completo.split("\n").filter((l) => l.startsWith("{"));
      if (lineas.length === 0) return [];
      return parseNdjson(lineas.join("\n") + "\n");
    };

    const logLectura: Lectura = { offset: 0, pending: "" };
    const hbLectura: Lectura = { offset: 0, pending: "" };
    const logRegs: HarnessRecord[] = [];
    const hbRegs: HarnessRecord[] = [];
    let verdict: Observacion["verdict"] = null;
    // Review punto 2: ancla del reloj. `mono` es del dispositivo; la ancla
    // fija el primer ev:"clock" (mono + epoch del host en ese instante) y
    // ahoraMono avanza con Date.now() del host. Sin ancla no se clasifica.
    let ancla: { mono: number; host: number } | null = null;
    // Review punto 4: estado de pidof entre polls.
    let pidVaciosConfirmados = 0;
    let pidDesconocidoDesde: number | null = null;

    const deadline = inicioAmStart + args.timeout * 1000;

    while (true) {
      logRegs.push(...(await leerIncremental("log.ndjson", logLectura)));
      hbRegs.push(...(await leerIncremental("heartbeat.ndjson", hbLectura)));

      // verdict.json (A12: O_EXCL, primero que escribe gana → una vez hallado,
      // no se vuelve a leer). Si el cat falla, está ausente: no es error fatal.
      if (verdict === null) {
        const res = run(adbCmd("exec-out", "run-as", PAQUETE, "cat",
          `files/runs/${runId}/verdict.json`));
        if (res.code === 0 && res.stdout.trim().length > 0) {
          try {
            const j = JSON.parse(res.stdout) as {
              outcome?: unknown;
              data?: { name?: unknown } | null;
            };
            if (j.outcome === "ok" || j.outcome === "crash") {
              verdict = { outcome: j.outcome, dataName: asCadena(j.data?.name) };
            }
          } catch {
            // verdict.json corrupto a mitad de escritura: se reintenta al próximo poll
          }
        }
      }

      // Review punto 4: pidVivo no puede ser false por un error de adb. Un
      // error de transporte no llega acá (run() lanza); code≠0 con el
      // comando terminado deja el pid DESCONOCIDO: este poll no clasifica.
      // A8.4 exige 2 polls consecutivos con pidof vacío y code 0 antes de
      // dead; si la incertidumbre dura 10 s, `env` con exit 2.
      const pidof = run(adbCmd("shell", "pidof", PAQUETE));
      // Semántica real de `pidof` en Android (toybox): code 1 con salida
      // vacía cuando NINGÚN proceso coincide — eso es "no hay pid", no un
      // error. Un error de transporte llega por otra vía: `run()` lanza con
      // code -1/timeout o `adb` escribe "error:" en stderr. Sólo eso deja el
      // pid DESCONOCIDO.
      const pidofSinProceso = pidof.code === 1 && pidof.stdout.trim().length === 0 &&
        !/error|offline|unauthorized/i.test(pidof.stderr);
      let pidDesconocido = false;
      let pidVivo: boolean;
      if (pidof.code !== 0 && !pidofSinProceso) {
        pidDesconocido = true;
        pidVivo = true; // desconocido: ninguna fila de A8 decide con esto
        pidVaciosConfirmados = 0;
        if (pidDesconocidoDesde === null) pidDesconocidoDesde = Date.now();
      } else {
        pidDesconocidoDesde = null;
        if (pidof.stdout.trim().length > 0) {
          pidVivo = true;
          pidVaciosConfirmados = 0;
        } else {
          pidVaciosConfirmados += 1;
          // Con un solo vacío confirmado todavía no se declara dead.
          pidVivo = pidVaciosConfirmados < 2;
        }
      }
      if (pidDesconocidoDesde !== null && Date.now() - pidDesconocidoDesde >= 10000) {
        console.error(
          `violeta-run: adb shell pidof salió con code ${pidof.code} sin salida interpretable ` +
            "durante 10 s; no se puede determinar el pid",
        );
        console.log(formatFinalLine({ runId, estado: "env", razon: "pid_desconocido", evidencia }));
        return EXIT_CODES.env;
      }

      // Derivados de los registros acumulados.
      const clockReg = ultimo(logRegs, (r) => r.ev === "clock");
      const clockT = clockReg ? asNumero(clockReg.mono) : null; // base mono: classify la compara con ahoraMono
      const jsBoot = logRegs.some((r) => r.ev === "js_boot");
      const ultimoHb = hbRegs.length > 0 ? hbRegs[hbRegs.length - 1] : null;
      const ultimoJs = ultimo(logRegs, (r) => r.src === "js");

      // Review punto 2: ahoraMono sale del reloj ANCLADO, no del máximo mono
      // leído: si el dispositivo deja de emitir, la diferencia sigue
      // avanzando y las filas 3, 5 y 6 de A8 pueden disparar. Sin ancla no
      // se clasifica (seguir pollendo); deadline agotado sin ancla → timeout.
      if (ancla === null && clockT !== null) ancla = { mono: clockT, host: Date.now() };
      const ahoraMono: Num =
        ancla === null ? null : ancla.mono + Math.max(0, Date.now() - ancla.host);
      const timeoutAgotado = Date.now() >= deadline;

      // A9: una línea de estado por poll; estado=corriendo siempre acá.
      const s =
        clockT !== null && ahoraMono !== null ? Math.max(0, (ahoraMono - clockT) / 1000) : 0;
      console.log(
        formatEstadoLine({
          s,
          seq: ultimoJs ? asNumero(ultimoJs.seq) : null,
          hb: beatDeHb(ultimoHb),
          phase: faseDeHb(ultimoHb),
        }),
      );

      // La corrida terminó cuando classify puede decidir. Sin ancla de reloj
      // o con pid desconocido no corresponde clasificar (salvo deadline
      // agotado con pid confirmable, en marcha: seguir pollendo).
      if (!pidDesconocido && (ahoraMono !== null || timeoutAgotado)) {
        const obs: Observacion = {
          precondicion: null,
          verdict,
          ahoraMono: ahoraMono ?? 0,
          clockT,
          jsBoot,
          pidVivo,
          ultimoHbT: ultimoHb ? asNumero(ultimoHb.mono) : null,
          ultimoJsSeq: ultimoJs ? asNumero(ultimoJs.seq) : null,
          ultimoJsSeqT: ultimoJs ? asNumero(ultimoJs.mono) : null,
          timeoutAgotado,
        };
        let resultado: { estado: Estado; razon: string } | null = null;
        try {
          resultado = classify(obs);
        } catch {
          // en marcha: seguir pollendo
        }
        if (resultado) {
          console.log(
            formatFinalLine({ runId, estado: resultado.estado, razon: resultado.razon, evidencia }),
          );
          return EXIT_CODES[resultado.estado];
        }
      }

      await dormir(POLL_MS);
    }
  } catch (err) {
    if (err instanceof FalloTransporte) {
      console.error(`violeta-run: el comando adb no respondió ni tras el reintento: ${err.detalle}`);
      console.log(formatFinalLine({ runId, estado: "env", razon: "adb_ausente", evidencia }));
      return EXIT_CODES.env;
    }
    throw err;
  }
}

process.exitCode = await main();
