# Brief curado: pi-ai / pi-agent-core para un plan (no hace falta leer los tarballs)

Todo lo de acá fue verificado por el orquestador sobre `.ref/npm/pi-ai@1.4.0` y `.ref/npm/pi-agent-core@1.4.0`.
Está resumido a propósito: **no abras los `.d.ts` ni los `.js` del tarball**, son enormes y agotan el turno.

## Paquetes
- `@earendil-works/pi-ai@1.4.0`, ESM, `engines.node >= 22.19`, `type: "module"`.
- `@earendil-works/pi-agent-core@1.4.0`, ESM, depende de `typebox` y de `pi-ai@1.4.0`.
- pi-ai declara deps pesadas de Node: `openai`, `@anthropic-ai/sdk`, `@google/genai`,
  `@aws-sdk/client-bedrock-runtime`, `http-proxy-agent`, `https-proxy-agent`, `@smithy/node-http-handler`.

## Import correcto para Hermes (el que usó el spike, verificado)
- **Sí**: `@earendil-works/pi-ai/api/openai-completions` → exporta `stream(model, context, options)` y `streamSimple(...)`.
- **No**: `@earendil-works/pi-ai` (barrel `index.js`) ni `@earendil-works/pi-ai/compat` (arrastra todos los adaptadores).

## Piezas del contrato
- `Model` (types.d.ts:630): `{ id, name, api: "openai-completions", provider, baseUrl, input: ["text"|"image", ...], cost, reasoning, contextWindow, maxTokens, compat? }`.
- Opciones por request (`ProviderRequestOptions`, types.d.ts:48): `{ apiKey?, fetch?, env?, signal?, telemetry? }` + `temperature?` + `onResponse?` + `onProviderStreamEvent?`.
- `fetch` es inyectable: bajo Hermes hay que pasar `expo/fetch` (el `fetch` global no streamea en RN).
- Eventos del stream (`AssistantMessageEvent`, types.d.ts:560-620), en orden:
  `start` → `text_start` → `text_delta {delta, partial}` (muchas) → `text_end` → `toolcall_start` →
  `toolcall_delta` → `toolcall_end {toolCall}` → `done`. Un fallo de setup termina en `error`.
  `streamSimple()` **lanza sincrónicamente** si falta la auth.
- `pi-agent-core` exporta `agent.ts`, `agent-loop.ts`, `proxy.ts`, `setDefaultStreamFn`, `types.ts`.

## NaN (del harness de escritorio, config/models.json)
- provider key `nan`, `baseUrl: https://api.nan.builders/v1`, `api: "openai-completions"`.
- modelos: `deepseek-v4-flash` (ctx 1M, maxTokens 16384, `compat.maxTokensField: "max_tokens"`),
  `glm5.3-flash`, `qwen3.8-flash`, `mimo-v2.6-flash`, `gemma4`, `qwen3.6`. Todos `cost: 0`.
- `glm5.3` (premium) queda fuera a propósito.

## Metro / Hermes
- Metro rechaza `import(<variable>)`. pi-ai 1.4.0 tiene 4 sitios, con archivo:línea exactos:
  `dist/env-api-keys.js:13`, `dist/auth/context.js:10`, `dist/auth/oauth/load.js:17`,
  `dist/api/bedrock-converse-stream.lazy.js:18` (este último es nuevo respecto del spike).
- Patch de referencia idempotente: `.ref/spike/patch-pi-ai.mjs` (reemplaza esos `import(...)` por un rechazo explícito).
- Hermes: tiene `fetch`, `ReadableStream`, `TextDecoder`, `AbortController`; **no tiene `crypto`**.

## Snapshot del proyecto (para no releerlo)
- `src/harness/record.ts`: serializador NDJSON único; `ev` es una **tabla cerrada** de 11 valores
  (`native_init`, `clock`, `request`, `js_boot`, `phase`, `log`, `js_error`, `uncaught`, `nojs_forced`, `verdict`, `hb`);
  un valor nuevo exige cambiarla. `secret(valor)` redacta como `***` en cualquier profundidad.
- `src/harness/obs.ts`: `VioletaObs.{mono,append,setPhase,setVerdict,takePendingRequest,hardKill}` sobre el Expo Module.
- `src/harness/runner.ts`: `runHeadlessOnce(deps)` toma el request, emite `request`/`js_boot`, busca
  `SCENARIOS[request.scenario]` (mapa en `runner.ts:149`), ejecuta y cierra con `setVerdict`. Los escenarios
  reciben un `ScenarioCtx` con `fase(name)`, `sleep(ms)`, `emitir(ev, data)`, `bloquear(ms)`, `hardKill()`.
- `tools/violeta-run.ts`: driver del host; agrega escenarios no requiere tocarlo (`--scenario <nombre>`).
- Estados finales del driver y sus exit: `ok` 0, `env` 2, `crash` 3, `dead` 4, `wedged` 5, `timeout` 6, `absent` 7.
