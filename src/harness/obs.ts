/**
 * Shim tipado sobre `NativeModules.VioletaObs` (T3).
 *
 * Contrato JS del módulo nativo (firmas que Kotlin registra):
 *   mono(): number                          → SystemClock.elapsedRealtime()
 *   append(line: string): number            → seq asignado por el writer
 *   setPhase(phase: string): void           → fase visible para los hb
 *   setVerdict(outcome: string, dataJson: string): void → verdict.json (A12)
 *   takePendingRequest(): {runId,scenario}|null         → una sola vez (A1)
 *   hardKill(): void                        → muerte inmediata (A11)
 *
 * La resolución es lazy y segura: importar este módulo en Node no explota
 * (los tests de T2/T5 corren sin React Native). En Node ESM `typeof require`
 * es "undefined" y las llamadas fallan con un error explícito; los tests
 * inyectan su propio reloj en makeRecorder({ mono }) o mockean VioletaObs.
 */

/** Request de la corrida entregado una única vez por el módulo nativo (A1). */
export interface PendingRequest {
  runId: string;
  scenario: string;
}

/** Forma del módulo nativo tal como lo ve JS. */
export interface VioletaObsModule {
  mono(): number;
  append(line: string): number;
  setPhase(phase: string): void;
  setVerdict(outcome: string, dataJson: string): void;
  takePendingRequest(): PendingRequest | null;
  hardKill(): void;
}

interface ReactNativeLike {
  NativeModules?: Record<string, VioletaObsModule | undefined>;
}

/**
 * Resuelve `NativeModules.VioletaObs` en el momento de la llamada (nunca al
 * importar, para que el import en Node no necesite React Native). Sólo hay
 * `require` dentro del bundle de Metro.
 */
function resolveNative(): VioletaObsModule | undefined {
  // El módulo es un Expo Module (modules/violeta-obs). En Node no existe
  // `expo-modules-core` resoluble como módulo nativo y los tests inyectan su
  // propio doble, así que el fallo es silencioso y localizado.
  if (typeof require !== "function") return undefined;
  try {
    const mod = require("expo-modules-core") as {
      requireNativeModule?: (name: string) => VioletaObsModule;
    };
    return mod.requireNativeModule?.("VioletaObs");
  } catch {
    return undefined;
  }
}

/** Diagnóstico de arranque: ¿el módulo nativo está visible desde JS? */
export function isNativeAvailable(): boolean {
  return resolveNative() !== undefined;
}

function sinModulo(op: string): never {
  throw new Error(
    `VioletaObs.${op}() no está disponible: el módulo nativo sólo existe dentro de la app en el dispositivo. ` +
      "Inyectá un reloj o un mock de test (makeRecorder({ mono }) / mock de VioletaObs).",
  );
}

export const VioletaObs: VioletaObsModule = {
  mono(): number {
    return resolveNative()?.mono() ?? sinModulo("mono");
  },

  append(line: string): number {
    const mod = resolveNative();
    if (mod === undefined) return sinModulo("append");
    return mod.append(line);
  },

  setPhase(phase: string): void {
    const mod = resolveNative();
    if (mod === undefined) return sinModulo("setPhase");
    mod.setPhase(phase);
  },

  setVerdict(outcome: string, dataJson: string): void {
    const mod = resolveNative();
    if (mod === undefined) return sinModulo("setVerdict");
    mod.setVerdict(outcome, dataJson);
  },

  takePendingRequest(): PendingRequest | null {
    return resolveNative()?.takePendingRequest() ?? null;
  },

  hardKill(): void {
    const mod = resolveNative();
    if (mod === undefined) return sinModulo("hardKill");
    mod.hardKill();
  },
};
