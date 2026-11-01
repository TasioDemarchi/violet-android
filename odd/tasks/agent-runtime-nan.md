# Motor de agente y NaN
Responder con streaming y ejecutar una herramienta real, dentro de la app y del arnés ya construido.
Runner: `node --test tests/*.test.ts` (host). En dispositivo, escenarios nuevos del arnés.
Profile: personal

## Contexto y evidencia (leer antes de escribir specs)

La feature 1 está terminada y verificada: ver `odd/tasks/headless-test-harness.md` (A1-A15, S1-S12, L15).
Ahí está cómo se observa una corrida: `VioletaObs`, `src/harness/record.ts`, `src/harness/runner.ts`
(con su mapa `SCENARIOS` en `runner.ts:149`), `tools/violeta-run.ts` y los cinco estados finales.

Decisiones ya aprobadas por el usuario (no re-abrir):

- Stack React Native + Expo 58 / RN 0.88 / Hermes, proyecto Android versionado, paquete `dev.tasio.violeta`.
- La API key de NaN la carga el usuario en la app; **nunca** se commitea ni aparece en un registro.
- Perfil personal. Sin multiusuario, sin backend propio, sin nube, sin iOS.
- El arnés es el canal de verificación en dispositivo: no se agrega otro.

Hechos verificados hoy por el orquestador (no hace falta re-descubrirlos):

- `@earendil-works/pi-ai@1.4.0` y `@earendil-works/pi-agent-core@1.4.0`, ambos ESM (`"type":"module"`),
  `engines.node >= 22.19` (irrelevante en runtime, pero obliga a no usar APIs de Node en el camino caliente).
- pi-ai arrastra SDKs pesados de Node (`openai`, `@anthropic-ai/sdk`, `@google/genai`, `@aws-sdk/client-bedrock-runtime`,
  `http-proxy-agent`). El spike anterior ya probó la salida: importar **sólo** el adaptador
  `@earendil-works/pi-ai/api/openai-completions` (expone `stream` y `streamSimple`), nunca el barrel `index`/`compat`.
- `Model` (pi-ai `dist/types.d.ts:630`) lleva `id`, `name`, `api`, `provider`, `baseUrl`, `input`, `cost`, `reasoning`,
  `contextWindow`, `maxTokens`; la `apiKey` va en las opciones de cada request (`ProviderRequestOptions.apiKey`,
  `dist/types.d.ts:52`), y `fetch` es inyectable (`dist/types.d.ts:58`) — necesario para pasar `expo/fetch` en Hermes.
- Metro sigue rechazando `import(variable)` y pi-ai 1.4.0 tiene **4** sitios: `dist/env-api-keys.js:13`,
  `dist/auth/context.js:10`, `dist/auth/oauth/load.js:17` y (nuevo respecto del spike) `dist/api/bedrock-converse-stream.lazy.js:18`.
  El patch de referencia está en `.ref/spike/patch-pi-ai.mjs` (idempotente, postinstall).
- `expo-secure-store` 58.0.2 es la versión del SDK 58 (API `setItemAsync`/`getItemAsync`).
- Hermes tiene `fetch`, `ReadableStream`, `TextDecoder`, `AbortController`; **no** tiene `crypto` (F2 del spike).
- El arnés ejecuta un escenario por nombre desde `SCENARIOS[request.scenario]` y el driver de host lo lanza con
  `--scenario <nombre>`: agregar un escenario nuevo no requiere tocar el driver.

## Architecture

A1 **Import Hermes-safe.** Sólo `src/nan/cliente.ts` importa `@earendil-works/pi-ai/api/openai-completions`
(`streamSimple`); el único especificador de pi-ai permitido en `src/` es exactamente ése (S1 lo verifica por igualdad del
conjunto, no con un grep negativo que dejaría pasar otro adaptador). Barrel `@earendil-works/pi-ai`, `/compat` y el resto de
los adaptadores quedan prohibidos en `src/`, **sin excepción para `import type`**: el tipo del modelo no se importa, se
deriva de `streamSimple` (A4), y así el check de S1 sigue siendo igualdad estricta de un solo elemento. Instalación con **npm** (el repo tiene `package-lock.json` y no `bun.lock`;
`bun add` no existe en este entorno): `npm i @earendil-works/pi-ai@1.4.0`.
Rechazo: el paquete entero arrastra `openai`, `@anthropic-ai/sdk`, `@google/genai`, `@aws-sdk/client-bedrock-runtime`
`http-proxy-agent`, que Metro intenta resolver y no shippean en Android.

A2 **Patch Metro (4 sitios).** `scripts/patch-pi-ai.mjs` invocado desde `postinstall`, idempotente, y con exit 1 si falta
el ancla de algún sitio (así un bump no reintroduce `import()` en silencio). Sitios exactos:
`dist/env-api-keys.js:13`, `dist/auth/context.js:10`, `dist/auth/oauth/load.js:17`, `dist/api/bedrock-converse-stream.lazy.js:18`.
Base: `.ref/spike/patch-pi-ai.mjs`. Rechazo: parchear a mano (se pierde en cada `install`) y `resolver.extraNodeModules`
(`import(variable)` se evalúa en runtime, no en la resolución de Metro).

A3 **Key.** `expo-secure-store` 58.0.2, un único ítem `violeta.nan.apiKey`; `setItemAsync` para guardar,
`deleteItemAsync` para borrar desde el botón "Borrar key", `getItemAsync` por envío (sin cachear en módulo).
Sin `requireAuthentication` (el prompt biométrico rompería la corrida headless). Todo el acceso pasa por `src/nan/key.ts`
con interfaz `AlmacenKey` e impls `SecureStoreKey` (dispositivo) y `MemoriaKey` (host). `key.ts` es además **dueño único**
del literal `nan: falta la key en el dispositivo`, exportado como `NAN_FALTA_KEY`: `cliente.ts` lo importa de ahí y no lo
repite (un literal con dos dueños deriva en dos textos distintos). `expo-secure-store` se resuelve **lazy** con `require`
dentro de la función, mismo patrón que `obs.ts` usa para `expo-modules-core`, para que `tests/nan-key.test.ts` corra en Node
sin el paquete nativo. Rechazo: import de tope de `expo-secure-store` en `key.ts` (rompería S3 en host con
`ERR_MODULE_NOT_FOUND`).
Rechazo: `AsyncStorage` (texto plano; la decisión aprobada pide almacenamiento seguro del sistema) y
`EXPO_PUBLIC_NAN_KEY` (la key viajaría en el bundle).

A4 **Modelo.** Literal en `src/nan/modelo.ts`: `id:"deepseek-v4-flash"`, `name:"deepseek-v4-flash"`,
`api:"openai-completions"`, `provider:"nan"`, `baseUrl:"https://api.nan.builders/v1"`, `input:["text"]`,
`maxTokens:16384`, `contextWindow:1000000`, `compat:{maxTokensField:"max_tokens"}`, `reasoning:false`, `cost` en ceros.
El **tipo** no se importa del barrel: en `cliente.ts` se declara `type Modelo = Parameters<typeof streamSimple>[0]` y
`type Opciones = NonNullable<Parameters<typeof streamSimple>[2]>`, y el literal de `modelo.ts` se anota `Modelo`. Motivo:
`api/openai-completions` exporta `streamSimple: StreamFunction<"openai-completions", SimpleStreamOptions>`, así que `[0]`
resuelve exactamente `Model<"openai-completions">` (lo que la llamada exige) y `[2]` las opciones con `apiKey`/`fetch`/
`signal`, sin que el barrel entre al grafo de Metro ni al check de S1. Rechazo: `import type { Model } from
"@earendil-works/pi-ai"` — obliga a que S1 exceptúe las líneas `import type`, y media línea después eso es un `import {
Model }` de valor, que S1 ya no distingue. Rechazo: leer `config/models.json` del harness de escritorio (no existe en el bundle) y `glm5.3` (premium, fuera a propósito).

A5 **fetch inyectado, jamás importado en el cliente.** `src/nan/cliente.ts` **no importa nada de Expo**: recibe `fetch`
como parámetro obligatorio de `crearCliente({fetch, timeoutMs, reloj})` y lo pasa tal cual a `ProviderRequestOptions.fetch`.
**Dueño único del `import { fetch } from "expo/fetch"` es `App.tsx`** (A12): de ahí sale el `fetch` de la pantalla (prop a
`chat.tsx`) y el `RunnerDeps.fetchImpl` que el runner mete en `ScenarioCtx.fetch` (A9), de donde lo toman los escenarios de
dispositivo; `src/harness/scenarios-nan.ts` no importa nada de Expo y los tests inyectan su propio `fetch` falso.
`FetchInyectable` se declara y exporta en `src/nan/cliente.ts` (tipo estructural mínimo:
`(url: string, init?: {method?, headers?, body?, signal?}) => Promise<{ok: boolean; status: number; body: unknown}>`);
`runner.ts` lo importa con `import type`, que no agrega ningún especificador de pi-ai (S1) ni código a Hermes. Motivo: un
import de Expo en el tope de `cliente.ts` **o de `scenarios-nan.ts`** rompe `node --test` con `ERR_MODULE_NOT_FOUND` y S10
nunca pasaría. Rechazo: default interno a `expo/fetch` (misma rotura), escenarios que importen `expo/fetch` por su cuenta
(mata la suite de host y deja dos dueños del composition root) y el `fetch` global de RN, que no streamea (`response.body` no
es `ReadableStream`) y entregaría la respuesta de una sola vez.

A6 **Una herramienta: `hora_actual`.** `{zona?: string}` → `{iso, zona, epochMs}`, ejecutada en el proceso de la app con
`new Date()` e `Intl.DateTimeFormat(...).resolvedOptions().timeZone` (reloj e `Intl` inyectables). El resultado vuelve al
modelo como tool result y el texto final tiene que contener el `iso` o la `zona` que devolvió la herramienta: un cliente
que descarte el tool result no lo contiene y falla S5. Obliga a un segundo request al provider (unidad de "turno", ver A7).
Motivo: es un dato que el modelo **no puede inventar**, así que un segundo request con la hora correcta prueba que la
herramienta corrió; no toca red, fs ni shell, y cabe en Hermes.
Rechazo: `sumar`/`eco` (el modelo las acierta sin llamar nada, no probarían ejecución) y cualquier herramienta de
archivos/shell (fuera de alcance).

A7 **Bucle acotado.** Máximo una ronda de herramienta por mensaje: tope de 2 requests al provider por mensaje (**unidad de
"turno" = un request al provider**). Si el modelo pide otra herramienta, se responde `{"error":"máximo una herramienta por mensaje"}`
y se cierra el mensaje. Rechazo: bucle ilimitado (sin historial ni
guardias —fuera de alcance— un modelo insistente cuelga la app).

A8 **Timeout / abort / HTTP.** Un `AbortController` por envío, `timeoutMs` **inyectable** con default `45000`
(`crearCliente({timeoutMs = 45000})`; el test pasa `50` y nadie espera 45 s), `signal` en las opciones; al vencer se `abort()`
y se muestra `mensajeTimeout(ms)` = `NaN tardó demasiado (<redondeo de ms/1000> s). Probá de nuevo.`, así que con el default el
literal es exactamente `NaN tardó demasiado (45 s). Probá de nuevo.`; al desmontar la pantalla se aborta y no se escribe más. Un no-2xx llega como `error` de stream y se muestra `NaN respondió con error: <status>`. Rechazo: reintentos
automáticos (multiplican consumo y no hay presupuesto en el perfil personal).

A9 **Escenarios.** `src/harness/scenarios-nan.ts` exporta `NAN_SCENARIOS`; `runner.ts:149` lo esparce con
`...NAN_SCENARIOS` dentro del literal de `SCENARIOS`. `tools/violeta-run.ts` no se toca. Nombres: `nan.stream`,
`nan.tool`, `nan.sin-key`, `nan.http-error`. Para el `fetch`, `runner.ts` suma `fetchImpl?: FetchInyectable` a `RunnerDeps`
y `fetch: FetchInyectable | undefined` a `ScenarioCtx` — son los únicos cambios en `runner.ts` además del spread de la línea
149 —; `defaultDeps()` lo deja indefinido (Node no tiene `expo/fetch`) y `App.tsx` lo inyecta. `nan.stream` y `nan.tool` usan
`ctx.fetch` y fallan con mensaje explícito si falta; `nan.sin-key` usa un fetch que lanza si se lo llama (así prueba que el
cliente corta antes de pedir); `nan.http-error` define su propio stub de 500 en el archivo y no toca la red ni `ctx.fetch`.
Cada escenario afirma sus invariantes y lanza si fallan, así el observable externo es el exit code (0 ok / 3 crash). Rechazo: registrar desde `tools/` (el driver es host-only) y un mapa paralelo
(el dispatcher ya resuelve por `SCENARIOS[request.scenario]`).

A10 **Cero `ev` nuevos.** La tabla cerrada de `record.ts` queda en 11 valores. Se usan `phase` (`key`, `stream`, `tool`,
`done`), `log` y `verdict`. `log` sólo lleva `data:{evt:"nan.sent"|"nan.first_delta"|"nan.done"|"nan.tool"|"nan.error",
ms, n, status}`: números, nombre de paso y `status` (obligatorio únicamente en `nan.error`, que es lo que S7 exige registrar);
**nunca** texto. Lo que no esté en esa lista de cuatro claves no se emite. Rechazo: un `ev:"nan_delta"` (obliga a cambiar tabla y validador nativo
para ganar nada: cada delta en NDJSON son megabytes y fuga de contenido).

A11 **Fuga cero.** La key vive en la closure del request y nunca en un `data`; si hiciera falta, va envuelta en `secret()`.
Del texto del modelo se emiten sólo `n` (deltas) y `ms`; la respuesta completa no se registra en ningún lado. El cuerpo de un 500 recortado a 200
caracteres puede ir al mensaje de pantalla pero **nunca** al error registrado. El almacén vacío es **sólo** de `nan.sin-key`: construye el cliente con una `MemoriaKey` nueva y vacía y afirma el throw,
sin tocar `SecureStore` ni la key real (borrarla destruiría el camino ya verificado y tocaría datos del usuario). `nan.stream`
y `nan.tool` usan `SecureStoreKey` —la key real que el usuario pega a mano en T7: sin key salen 3, que es la señal correcta de
que falta el paso manual— y `nan.http-error` usa una `MemoriaKey` con `key-sentinela-no-real` más el stub de 500, así que
ejercita el camino de error sin key real y sin red. Rechazo: confiar sólo en `secret()` (un `data` armado a mano la fuga igual).

A12 **Pantalla sin router.** El chat es un componente en `src/app/chat.tsx` montado desde `index.ts` → `App.tsx` con estado
local (`useState<"home"|"chat">`), que lo muestra u oculta; no se instala `expo-router` ni ninguna dependencia nueva y el
arranque del arnés (`runHeadlessOnce`) queda intacto en `App.tsx`. `App.tsx` es el composition root y el **único** dueño de `import { fetch } from "expo/fetch"`: se lo pasa a `chat.tsx` por
prop (junto con el `SecureStoreKey`) y lo entrega al arnés como `RunnerDeps.fetchImpl`; `chat.tsx` no importa nada de Expo. `tsconfig.json` suma `src/**/*.tsx` a `include` para que `npx tsc --noEmit` typechequee la pantalla.
Rechazo: `expo-router` (dep nueva que no está instalada y obligaría a mover `index.ts`) y una ruta fuera de `src/app/`
(quedaría fuera del typecheck).

## Specs

S1. **Import Hermes-safe.** Todos los especificadores de `@earendil-works/pi-ai` en `src/` son exactamente
`@earendil-works/pi-ai/api/openai-completions`: ni el barrel, ni `/compat`, ni otro adaptador (un grep negativo dejaría pasar
`pi-ai/api/anthropic-messages`). No hay excepción para `import type`: el tipo `Model` no se importa del barrel, se deriva de
`streamSimple` (A4), así que el conjunto permitido sigue teniendo un solo elemento.
`Check: test "$(grep -rhoE '@earendil-works/pi-ai[a-z/-]*' src | sort -u)" = '@earendil-works/pi-ai/api/openai-completions'`

S2. **Patch Metro idempotente y cableado.** Correr el script dos veces deja exit 0 y los 4 sitios sin `import(`; la cadena
`patch-pi-ai` está bajo `scripts.postinstall` de `package.json` (no en cualquier otro lado del archivo).
`Check: node -e 'process.exit(/patch-pi-ai/.test((require("./package.json").scripts||{}).postinstall||"")?0:1)' && node scripts/patch-pi-ai.mjs && node scripts/patch-pi-ai.mjs && ! grep -Rq "import(" node_modules/@earendil-works/pi-ai/dist/env-api-keys.js node_modules/@earendil-works/pi-ai/dist/auth/context.js node_modules/@earendil-works/pi-ai/dist/auth/oauth/load.js node_modules/@earendil-works/pi-ai/dist/api/bedrock-converse-stream.lazy.js`

S3. **Key en almacenamiento seguro del sistema.** Ítem `violeta.nan.apiKey` con `setItemAsync`/`getItemAsync`/
`deleteItemAsync`; sin key, el cliente lanza `nan: falta la key en el dispositivo` **antes** de cualquier request. Los textos
de pantalla —`Falta la key de NaN. Pegala y tocá Guardar.`, `Key guardada.`, `Key borrada del dispositivo.`— no tienen
verificación automática (**UNKNOWN** para el runner) y quedan como inspección manual explícita en T7. El único literal que fija
un test es el throw del cliente, y tiene **dueño único** en `src/nan/key.ts` como `NAN_FALTA_KEY`: aparece exactamente una vez
en `src/` y `cliente.ts` lo importa (A3).
`Check: test "$(grep -ro 'nan: falta la key en el dispositivo' src | wc -l | tr -d ' ')" = 1 && node --test tests/nan-key.test.ts`

S4. **Streaming visible.** Cada `text_delta` se concatena al texto mostrado, en el orden del stream; al cerrar, el texto
mostrado es exactamente la concatenación de los deltas; `nan.stream` observa ≥ 2 deltas y texto final no vacío.
`Check: node --test tests/nan-cliente.test.ts` (la parte de dispositivo va en S11, `nan.stream`)

S5. **Herramienta real ejecutada por la app y devuelta al modelo.** Con el pedido `¿Qué hora es? Usá la herramienta
hora_actual.` el stream trae un `toolcall` `hora_actual`, la app la ejecuta una vez, el resultado `{iso,zona,epochMs}` viaja en
un segundo request y **el texto final contiene el `iso` o la `zona` que devolvió la herramienta** (un cliente que descarte el
tool result no lo contiene y falla). El conteo observable es el número de requests al provider: exactamente 2.
`Check: node --test tests/nan-tool.test.ts` (la parte de dispositivo va en S11, `nan.tool`)

S6. **fetch inyectado, timeout y abort.** `cliente.ts` no importa nada de Expo: el objeto que llega a
`ProviderRequestOptions.fetch` es el mismo que se pasó a `crearCliente` (un `fetch` falso de identidad verificable); con
`timeoutMs: 50` un envío que no responde aborta (`signal.aborted`) y muestra `mensajeTimeout(50)`, mientras
`mensajeTimeout(45000)` es exactamente `NaN tardó demasiado (45 s). Probá de nuevo.`; tras `abort()` no se escribe más texto.
`Check: node --test tests/nan-cliente.test.ts`

S7. **Error HTTP.** Un 500 produce `NaN respondió con error: 500`; el mensaje de pantalla puede incluir el cuerpo recortado
a 200 caracteres, pero el error registrado **no** lo lleva (sólo `status`, `ms`, `n`; el body únicamente dentro de `secret()`),
y no queda estado de streaming abierto.
`Check: node --test tests/nan-cliente.test.ts`

S8. **La key y la respuesta completa no llegan al NDJSON.** Con la key centinela `key-sentinela-no-real` y una respuesta
centinela de longitud par, ninguna línea emitida por `makeRecorder` contiene la key ni la **segunda mitad** de la respuesta,
definida como `respuesta.slice(respuesta.length / 2)` (corte exacto en el índice `length/2`; el test usa 40 caracteres, o sea
`slice(20)`). Para el 500 se aplica la misma regla al cuerpo: `cuerpo.slice(cuerpo.length / 2)` tampoco aparece.
`Check: node --test tests/nan-log.test.ts`

S9. **Escenarios nuevos sin tocar el driver.** `NAN_SCENARIOS` expone exactamente `nan.stream`, `nan.tool`,
`nan.sin-key`, `nan.http-error`; `runner.ts` lo esparce en `SCENARIOS` y es el único que cablea el `fetch` (`RunnerDeps` →
`ScenarioCtx`); `scenarios-nan.ts` no importa nada de Expo; `tools/violeta-run.ts` no cambia.
`Check: node --test tests/nan-escenarios.test.ts && ! grep -q "expo/" src/harness/scenarios-nan.ts && ! grep -q "expo/" src/nan/cliente.ts`

S10. **Host verde.** Typecheck y las cinco suites de host pasan.
`Check: npx tsc --noEmit && node --test tests/nan-key.test.ts tests/nan-cliente.test.ts tests/nan-tool.test.ts tests/nan-log.test.ts tests/nan-escenarios.test.ts`

S11. **En dispositivo (orquestador).** Tras build+install y con la key ya pegada a mano (T7), los 4 escenarios salen 0;
`nan.stream` y `nan.tool` corren con `SecureStoreKey` (sin key salen 3, que es la señal de que falta el paso manual);
`nan.sin-key` usa la `MemoriaKey` vacía y afirma el literal exacto del throw del cliente `nan: falta la key en el dispositivo`
(no el texto de pantalla), saliendo 3 si difiere o si la app llegara a pedir; `nan.http-error` usa la `MemoriaKey` centinela y
el stub de 500; `nan.tool` exige exactamente 2 requests al provider. Cada corrida usa un `runId` **único** (`$(date +%s)` más
el pid): el driver rechaza un `runId` repetido con exit 2.
`Check: for s in stream tool sin-key http-error; do RUN="s11-$s-$(date +%s)-$$"; node tools/violeta-run.ts --scenario "nan.$s" --runId "$RUN" --timeout 120 || { echo "S11_FAIL $s"; exit 1; }; done; echo S11_OK`

## Tasks

T1. [DONE] Deps con **npm** (hay `package-lock.json`, no `bun.lock`; `bun add` no existe acá): `npx expo install expo-secure-store` y
`npm i @earendil-works/pi-ai@1.4.0`; `scripts/patch-pi-ai.mjs` idempotente con guard de anclas y `postinstall`, un solo import de pi-ai (el adaptador) y cero imports del barrel: el tipo `Modelo` se deriva con
`Parameters<typeof streamSimple>` (A4) — specs: S1,S2 — test: required — commit: -
T2. [DONE] `src/nan/key.ts`: `AlmacenKey`, `SecureStoreKey`/`MemoriaKey`, ítem `violeta.nan.apiKey`, literales de falta de key,
guardada, borrada + `tests/nan-key.test.ts` — specs: S3 — test: required — commit: -
T3. [DONE] `src/nan/modelo.ts` + `src/nan/cliente.ts`: `streamSimple` vía adaptador, `fetch` **por parámetro** (nada de Expo en el
archivo), `timeoutMs` inyectable (default 45000) con `mensajeTimeout(ms)`, ensamblado de deltas, abort, error HTTP +
`tests/nan-cliente.test.ts` — specs: S4,S6,S7 — test: required — commit: -
T4. [DONE] `src/nan/herramientas.ts`: `hora_actual` (reloj e `Intl` inyectables) y bucle de una ronda con resultado devuelto al
modelo + `tests/nan-tool.test.ts` — specs: S5 — test: required — commit: -
T5. [DONE] `src/app/chat.tsx` como componente (sin router, sin deps nuevas) montado desde `App.tsx` con estado local; `App.tsx` es el dueño único de `import { fetch } from "expo/fetch"` y le pasa a la
pantalla `fetch` y el `SecureStoreKey` por prop (la pantalla no importa nada de Expo), campo de key con Guardar/Borrar,
entrada de mensaje, texto en streaming, literales de error, `testID`; `App.tsx` entrega además `fetch` como
`RunnerDeps.fetchImpl`; `src/**/*.tsx` sumado al `include` de `tsconfig.json` — specs: S3,S4,S6,S7 — test: recommended — commit: -
T6. [DONE] `src/harness/scenarios-nan.ts` con `NAN_SCENARIOS` (4 nombres; `nan.stream`/`nan.tool` con `SecureStoreKey`, `nan.sin-key`
con `MemoriaKey` nueva y vacía, `nan.http-error` con `MemoriaKey` centinela y stub de 500; `fetch` tomado de `ctx` y ningún
import de Expo), `fetchImpl` en `RunnerDeps` + `fetch` en `ScenarioCtx` + spread en `runner.ts:149`, `tests/nan-log.test.ts` con los centinelas y su regla de corte + `tests/nan-escenarios.test.ts` —
specs: S8,S9 — test: required — commit: -
T7. **Sólo orquestador** (sin `adb`/`gradle`/`SDK` en el sandbox): build e install, pegar la key a mano, correr los 4
escenarios del arnés, adjuntar los exit codes, e inspeccionar a mano los literales de pantalla que S3 marca **UNKNOWN** (falta
de key, guardada, borrada) — specs: S10,S11 — test: required — commit: -

Dependencias: T1 → T2 ∥ T3 → T4 → T5 ∥ T6 → T7. Independientes en paralelo: T2/T3 (tras T1) y T5/T6 (tras T4).

## Log
L1 (pedido del usuario, verbatim):
"Vamos con lo que sigue"

L2 (contexto de qué es "lo que sigue", verbatim del mensaje del orquestador que el usuario aceptó):
"La próxima feature es el motor: cargar la key de NaN en la app, hablar con `deepseek-v4-flash`, streaming y una llamada a herramienta. Todo eso ya se puede construir sabiendo que, si algo falla, el arnés te dice cuál de los cuatro silencios es."

L3: "Correcciones de la ronda 1 de review de specs (10 hallazgos): npm; fetch inyectado; S5 exige el dato de la herramienta en el texto final; pantalla sin router + tsconfig con .tsx; grep estricto de pi-ai; nan.sin-key con almacén en memoria vacío; literal exacto de falta de key; timeout inyectable; cuerpo del 500 no va al log; 'turno' = request al provider."

L4: "Corrección de la ronda 2 de review de specs: el tipo `Model` se deriva de `streamSimple` en vez de importarse del barrel (S1/A4/T1); el `fetch` de los escenarios llega por `ScenarioCtx` desde `RunnerDeps`, sin imports de Expo en `scenarios-nan.ts` (A5/A9/S9/T6); el almacén vacío es sólo de `nan.sin-key` y los demás escenarios usan `SecureStoreKey` o la `MemoriaKey` centinela (A11/S11/T6); `NAN_FALTA_KEY` es dueño único del literal de falta de key (A3/S3); `status` entra en la lista cerrada de `log.data` (A10); `App.tsx` es el dueño único del composition root de `expo/fetch` (A5/A12/T5); S2 chequea la cadena bajo `scripts.postinstall`; S11 usa `runId` únicos por ejecución."

L5 (estado de implementación, 01-nov 01:40):
- T1 verificado: `@earendil-works/pi-ai@1.4.0` + `expo-secure-store@58.0.2`; `scripts/patch-pi-ai.mjs` parchea los 4 sitios, es idempotente (dos corridas exit 0) y falla con exit 1 si un ancla desaparece; `postinstall` cableado.
- T2/T3/T4: `src/nan/key.ts` (10 tests), `src/nan/cliente.ts` + `src/nan/modelo.ts` (7 tests), `src/nan/herramientas.ts` (4 tests). 74 tests verdes, `tsc` limpio.
- T5/T6 los escribió el orquestador: los workers de T3 y T6 se colgaron (uno murió "stalled: no activity for 30 min"). `src/app/chat.tsx`, `App.tsx` como composition root, `src/harness/scenarios-nan.ts`, `tests/nan-log.test.ts`, `tests/nan-escenarios.test.ts`.
- Hallazgo de dispositivo (Hermes): `cliente.ts` asignaba a un `let` declarado antes del `Promise` executor y Hermes falló con `Property 'rechazarPorTiempo' doesn't exist` → `nan.http-error` daba `crash` exit 3. Reescrito sin variables con inicialización diferida; ahora el escenario sale `ok` exit 0. El test de host no lo detectaba porque Node sí lo tolera: otra prueba de que la corrida en dispositivo es la que manda.
- En tablet, con el arnés: `nan.sin-key` → `ok` exit 0 (corta antes de cualquier request) y `nan.http-error` → `ok` exit 0 (status 500 sin filtrar el cuerpo).
- Pendiente para T7: `nan.stream` y `nan.tool` necesitan la key real, que la pega el usuario en la app (decisión L1: la key nunca pasa por el orquestador).
