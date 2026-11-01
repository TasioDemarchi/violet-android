/**
 * T6 (mitad pura): clasificador de las filas 1..7 de A8 y formato de stdout
 * de A9. No toca adb, ni red, ni procesos: recibe observaciones ya recolectadas
 * y decide. El driver (tools/violeta-run.ts) recolecta y llama estas piezas.
 */

export type Precondition = {
  razon: "adb_ausente" | "am_start_fallo" | "run_dir_ausente" | "uso_invalido";
  detalle: string;
};

export type Estado = "ok" | "crash" | "dead" | "wedged" | "timeout" | "absent" | "env";

export const EXIT_CODES: Record<Estado, number> = {
  ok: 0,
  env: 2,
  crash: 3,
  dead: 4,
  wedged: 5,
  timeout: 6,
  absent: 7,
};

export type Observacion = {
  precondicion: Precondition | null;
  verdict: { outcome: "ok" | "crash"; dataName?: string | null } | null;
  ahoraMono: number;
  clockT: number | null;
  jsBoot: boolean;
  pidVivo: boolean;
  ultimoHbT: number | null;
  ultimoJsSeq: number | null;
  ultimoJsSeqT: number | null;
  timeoutAgotado: boolean;
};

/**
 * A8 en orden exacto, mutuamente excluyente: la primera fila que matchea gana.
 * Las comparaciones de tiempo exigen que el dato exista: un `null` (dato que
 * no llegó) no satisface ninguna fila de tiempo, no lo inventa.
 */
export function classify(o: Observacion): { estado: Estado; razon: string } {
  // A8.0: precondición de entorno (A7 p1..p5), antes de cualquier clasificación.
  if (o.precondicion) return { estado: "env", razon: o.precondicion.razon };

  // A8.1/A8.2: veredicto del dispositivo, gana siempre.
  if (o.verdict) {
    if (o.verdict.outcome === "ok") return { estado: "ok", razon: "-" };
    return { estado: "crash", razon: o.verdict.dataName ?? "-" };
  }

  // A8.3: sin veredicto, ≥15 s desde ev:"clock" y sin ev:"js_boot" → nunca hubo runner.
  if (o.clockT !== null && o.ahoraMono - o.clockT >= 15000 && !o.jsBoot) {
    return { estado: "absent", razon: "js_ausente" };
  }

  // A8.4: hubo js_boot y el proceso ya no está.
  if (o.jsBoot && !o.pidVivo) return { estado: "dead", razon: "sin_pid" };

  // A8.5: pid vivo con latido más viejo que 3000 ms: el proceso está, el hilo no.
  if (o.ultimoHbT !== null && o.ahoraMono - o.ultimoHbT > 3000) {
    return { estado: "wedged", razon: "process" };
  }

  // A8.6: latido al día, pero el último seq de src:"js" sin avanzar en 20 s.
  if (o.ultimoJsSeqT !== null && o.ahoraMono - o.ultimoJsSeqT >= 20000) {
    return { estado: "wedged", razon: "js" };
  }

  // A8.7: todo avanzando y el --timeout agotado.
  if (o.timeoutAgotado) return { estado: "timeout", razon: "deadline" };

  throw new Error(
    "clasificación sin fila de A8: la observación corresponde a una corrida todavía en marcha",
  );
}

// ---------------------------------------------------------------------------
// Formato y parseo de las tres formas de línea de A9
// ---------------------------------------------------------------------------

const GUION = "-";

export function formatEstadoLine(x: {
  s: number;
  seq: number | null;
  hb: number | null;
  phase: string | null;
}): string {
  const seq = x.seq === null ? GUION : String(x.seq);
  const hb = x.hb === null ? GUION : String(x.hb);
  const phase = x.phase === null ? GUION : x.phase;
  return `violeta: t=${x.s.toFixed(1)}s seq=${seq} hb=${hb} phase=${phase} estado=corriendo`;
}

export function formatFinalLine(x: {
  runId: string;
  estado: Estado;
  razon: string;
  evidencia: string | null;
}): string {
  const evidencia = x.evidencia === null ? GUION : x.evidencia;
  return `violeta: run ${x.runId} estado=${x.estado} razon=${x.razon} evidencia=${evidencia}`;
}

export function formatClockLine(preOpost: "pre" | "post", epochMs: number): string {
  return `violeta: clock host_${preOpost}=${epochMs}`;
}

export type EstadoLine = {
  s: number;
  seq: number | null;
  hb: number | null;
  phase: string | null;
};

const RE_ESTADO = /^violeta: t=(\d+(?:\.\d+)?)s seq=(\d+|-) hb=(\d+|-) phase=(\S+|-) estado=corriendo$/;

export function parseEstadoLine(l: string): EstadoLine | null {
  const m = RE_ESTADO.exec(l);
  if (!m) return null;
  const num = (g: string): number | null => (g === GUION ? null : Number(g));
  return {
    s: Number(m[1]),
    seq: num(m[2]),
    hb: num(m[3]),
    phase: m[4] === GUION ? null : m[4],
  };
}

export type FinalLine = {
  runId: string;
  estado: Estado;
  razon: string;
  evidencia: string | null;
};

// `evidencia` es un comando con espacios y sin comillas: se traga el resto de la línea.
const RE_FINAL = /^violeta: run (\S+) estado=(\S+) razon=(\S+) evidencia=(.*)$/;

const ESTADOS: readonly string[] = ["ok", "crash", "dead", "wedged", "timeout", "absent", "env"];

export function parseFinalLine(l: string): FinalLine | null {
  const m = RE_FINAL.exec(l);
  if (!m) return null;
  if (!ESTADOS.includes(m[2])) return null;
  return {
    runId: m[1],
    estado: m[2] as Estado,
    razon: m[3],
    evidencia: m[4] === GUION ? null : m[4],
  };
}
