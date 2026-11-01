// Metro rechaza `import(<variable>)` de forma directa: su opción `dynamicRequires`
// sólo cubre `require()`. pi-ai usa import dinámico para caminos que sólo existen
// en Node (lectura de env, contexto de auth, servidor OAuth y el adaptador lazy de
// Bedrock). En Hermes esos caminos no se ejecutan nunca, pero el bundle no compila
// si la sintaxis sigue ahí.
//
// Este script reemplaza cada uno de esos `import(...)` por un rechazo explícito:
// el bundle compila y, si alguna vez se ejecutara ese camino, falla fuerte y claro
// en vez de fallar por una característica del motor.
//
// Es idempotente y falla con exit 1 si un ancla desaparece: un bump de pi-ai que
// reintroduzca `import()` no puede pasar desapercibido.
import { readFileSync, writeFileSync } from "node:fs";

const BASE = "node_modules/@earendil-works/pi-ai/dist/";

/** Cada sitio verificado sobre pi-ai 1.4.0 (ver brief de la feature). */
const SITIOS = [
  "env-api-keys.js",
  "auth/context.js",
  "auth/oauth/load.js",
  "api/bedrock-converse-stream.lazy.js",
];

const PATRON = /import\(__rewriteRelativeImportExtension\(([\w.]+)\)\)/g;

const rechazo = (spec) =>
  `Promise.reject(new Error("dynamic import of " + ${spec} + " no existe en Hermes"))`;

let fallos = 0;

for (const archivo of SITIOS) {
  const ruta = BASE + archivo;
  let src;
  try {
    src = readFileSync(ruta, "utf8");
  } catch {
    console.error(`patch-pi-ai: falta ${ruta} (¿pi-ai instalado?)`);
    fallos += 1;
    continue;
  }

  if (!src.includes("import(__rewriteRelativeImportExtension(")) {
    if (src.includes("no existe en Hermes")) {
      console.log(`patch-pi-ai: ya parcheado ${archivo}`);
    } else {
      console.error(
        `patch-pi-ai: ANCLA PERDIDA en ${archivo}: no hay import(__rewriteRelativeImportExtension(...)) ` +
          "ni marca de parche previo. Revisá el bump de pi-ai antes de seguir.",
      );
      fallos += 1;
    }
    continue;
  }

  const salida = src.replace(PATRON, (_m, spec) => rechazo(spec));
  if (salida === src) {
    console.error(`patch-pi-ai: ANCLA PERDIDA en ${archivo}: el patrón no coincidió`);
    fallos += 1;
    continue;
  }
  writeFileSync(ruta, salida);
  console.log(`patch-pi-ai: parcheado ${archivo}`);
}

if (fallos > 0) {
  console.error(`patch-pi-ai: ${fallos} sitio(s) sin parchear`);
  process.exit(1);
}
