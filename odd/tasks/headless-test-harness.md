# Arnés de test headless en dispositivo
Observar de forma atribuible una corrida automatizada dentro de la app Android, desde el host, sin tocar la pantalla.
Runner: `node --test tests/*.test.ts` (Node 24, TS nativo). Sin runner de device: las corridas en dispositivo se verifican con los escenarios de autoprueba del arnés.
Profile: personal

## Contexto y evidencia (leer antes de escribir specs)

- `.ref/brief-desktop-harness.md` — mapa del harness de escritorio `violeta` (fuente de ideas a portar).
- `.ref/brief-sandbox-observability.md` — capacidades del sandbox de los subagentes + fallas medidas (F9/F10/F11/F8).
- `.ref/spike/spike-hermes-runtime.md` — hallazgos en dispositivo del spike anterior (el código se descarta, los hallazgos no).
- `.ref/violeta/` — copia de sólo lectura del harness de escritorio.

Hechos que condicionan el diseño y no deben re-descubrirse:

1. Los subagentes corren en un sandbox limitado al directorio del proyecto: sin `adb`, sin `gradle`, sin `~/Android/Sdk`, sin `~/.gradle`, sin `/tmp`, sin `/dev/null`, `rm -f` bloqueado. **Los builds e instalaciones los ejecuta el orquestador en el host**. Toolchain del host: JDK 21.0.5 (Temurin), SDK en `~/Android/Sdk` (android-36, android-37.0, build-tools 35/36/37, NDK 27.1.12297006), Gradle 8.14.3 y 9.4.1 cacheados en `~/.gradle/wrapper/dists`, red abierta.
2. No hay dispositivo conectado todavía. La verificación en dispositivo ocurre cuando el usuario conecte la tablet (Lenovo Legion Tab TB323FU, arm64, Android 16). Todo hasta T6 debe completarse y compilar sin dispositivo.
3. Hermes en dispositivo tiene fetch, ReadableStream, TextDecoder, URL, AbortController, structuredClone; **no tiene `crypto`**. `console.log` de JS **no llegó a logcat** en el spike: no asumir logcat como canal de JS.
4. `pi-ai` usa `import(variable)` que Metro rechaza; el spike lo resolvió con un patch postinstall (`patch-pi-ai.mjs`). Esa técnica queda disponible pero **no es parte de esta feature**.

Decisiones ya aprobadas por el usuario (no re-abrir): stack React Native + Expo (bare/prebuild), Hermes, reusando `@earendil-works/pi-agent-core` y `@earendil-works/pi-ai`; observabilidad con **módulo nativo Kotlin** (append con fsync por registro, heartbeat escrito por hilo nativo -no por JS-, captura de excepción no atrapada, espejo a logcat desde la init nativa); alcance de esta feature **sólo el arnés** (sin UI de chat, sin llamada a NaN, sin sesiones, sin herramientas del agente); paquete `dev.tasio.violeta`, app "Violeta"; perfil personal, autonomía nivel 0.

## Architecture

A1. **Disparo sin taps**: cada corrida son **dos** comandos, en este orden: (1) `adb shell am force-stop dev.tasio.violeta`, (2) `adb shell am start -n dev.tasio.violeta/.MainActivity --es violeta.scenario <nombre> --es violeta.runId <runId>`. Kotlin lee los extras en `MainActivity.onCreate`, los persiste en `request.json` y los expone al JS por `VioletaObs.takePendingRequest()`. **`MainActivity` no maneja `onNewIntent`**: un intent que llegue con el proceso vivo se ignora (no fija pending request, no escribe `request.json`), porque el writer y el `runId` se atan en la init nativa y atender un segundo `runId` exigiría re-ligar el writer y re-emitir `native_init`/`clock`. Razón del force-stop: el manifest de `expo prebuild` declara `android:launchMode="singleTask"` (`android/app/src/main/AndroidManifest.xml:19`), así que un segundo `am start` sobre un proceso vivo **no** llamaría `onCreate` y la corrida nueva quedaría sin `native_init`/`clock` (A7 p4 `run_dir_ausente`); el force-stop garantiza `onCreate` en cada corrida, un `pid` que pertenece sólo a esa corrida (condición de la fila 4 de A8, `dead`) y un `ev:"clock"` por corrida; cuesta ~1 s por corrida y **no borra evidencia** (es `am force-stop`, nunca `pm clear`: `files/runs/` sobrevive, S8). Razón: un comando único por corrida que funciona con la app force-stopped y no necesita JS vivo. Rechazado: manejar `onNewIntent` como camino normal (hay que re-ligar writer + `runId` y re-emitir `native_init`/`clock` dentro de un proceso sucio, y dos corridas terminan mezcladas en un mismo proceso); polling de `autotest-request.json` del spike (requiere JS ya vivo, 2 s de latencia); `BroadcastReceiver` exportado (más superficie, igual hay que levantar el proceso); foreground service (restricciones de arranque en background en Android 16).
A2. **Artefactos**: bajo storage privado, `files/runs/<runId>/` = `log.ndjson`, `heartbeat.ndjson`, `request.json`, `verdict.json`. **No existe `files/runs/latest` ni ningún otro puntero mutable**: el `runId` lo fija siempre el host y el driver lo exige (`--runId` obligatorio); si el extra falta (arranque manual desde el launcher), Kotlin usa `orphan-yyyyMMdd-HHmmss-SSS`. Razón: elimina el único archivo que habría que reabrir en modo `w` y con eso la contradicción con S8, y elimina la necesidad de descubrir el `runId` desde el host. Rechazado: puntero `latest` reescrito (viola append-only); `latest` como append de una línea por corrida (archivo extra sin consumidor, porque el host ya sabe el `runId`).
A3. **Frontera de serialización**: el **único serializador de registros de JS es `src/harness/record.ts`**; produce la línea completa menos `seq`, con las claves en este orden exacto: `t`, `mono`, `src`, `lvl`, `ev`, `phase`, `data`. El valor de `mono` **no lo calcula JS**: `record.ts` lo pide a una llamada síncrona al módulo nativo, `VioletaObs.mono()`, que devuelve `SystemClock.elapsedRealtime()` —la misma base que usan los cuatro registros nativos y los `hb`—; `record.ts` recibe ese reloj como dependencia (`makeRecorder({mono})`, default `VioletaObs.mono()`) para que `node --test` lo reemplace por un fake determinista. Hermes no expone `elapsedRealtime`: `performance.now()` cuenta desde el arranque del runtime JS y `Date.now()` es reloj de pared, así que ninguno sirve como `mono`. `t` en cambio sí lo pone JS (`Date.now()`), y es el único tiempo que JS elige. Kotlin recibe ese string en `VioletaObs.append(line)` y, dentro del lock del writer, emite `"{\"seq\":" + n + "," + line.substring(1)`. Kotlin serializa a mano **sólo sus cuatro registros propios** (`native_init`, `clock`, `uncaught`, `nojs_forced`) y los de `heartbeat.ndjson`, con la misma lista de claves y el mismo orden. Razón: un solo serializador para todo lo que el runner emite, testeable con `node --test` sobre el string real que llega al archivo; Kotlin queda con splice + `seq` + fsync, verificable por inspección y por un check de orden de claves sobre el archivo real (S4). Rechazado: que Kotlin inyecte `mono` por splice como inyecta `seq` (obligaría a Kotlin a partir la línea de JS en el medio, justo después del valor de `t`, y el test de TS dejaría de probar el orden de claves del archivo real); `Date.now()` o `performance.now()` como `mono` (otra base: los `mono` de JS y los de `hb`/nativos dejarían de ser comparables entre sí, que es lo único para lo que sirve `mono`); serializar en Kotlin a partir de campos (el test de TS dejaría de probar el archivo); dos writers (el `seq` deja de ser total).
A4. **Writer y espejo**: writer único, `FileOutputStream(append=true)` + `fd.sync()` por registro, `seq` entero monotónico global por corrida bajo lock único. El mismo writer hace `Log.i("violeta", runId + " " + linea)`; el prefijo `runId` permite filtrar logcat por corrida: `adb logcat -d -s violeta:I | grep "$RUN "`.
A5. **Lectura desde host**: `adb exec-out run-as dev.tasio.violeta cat files/runs/<runId>/log.ndjson`. `exec-out` y no `shell` porque `shell` reescribe LF a CRLF. Incremental: `adb exec-out run-as dev.tasio.violeta tail -c +<offset+1> files/runs/<runId>/log.ndjson`, con `offset` = bytes ya leídos de ese archivo en esta corrida.
A6. **Heartbeat no bloqueable**: `Thread` daemon arrancado en la init nativa, 1000 ms, append a `heartbeat.ndjson` con `ev:"hb"` y `data:{beat,pid,jsPhase,jsSeq}`; `beat` es un contador que arranca en 0 y sube de 1 en 1. `jsPhase`/`jsSeq` son `@Volatile` que el JS actualiza con `VioletaObs.setPhase(p)` / al confirmar cada append; si el JS se bloquea, el latido sigue con la fase vieja. Rechazado: heartbeat en `setInterval` de JS (F9/req 4).
A7. **Precondición de entorno, antes de cualquier clasificación** (cierra "nunca arrancó" ≠ "arrancó y murió", review spec-2): el driver, en orden, (p1) `adb get-state` distinto de `device` → exit 2 `razon=adb_ausente`; (p2) `am force-stop` de A1 y el proceso **no** ausente a los 5 s (`adb shell pidof dev.tasio.violeta` no vacío, o el force-stop falla) → exit 2 `razon=am_start_fallo`; (p3) salida de `am start` contiene `Error:` o `Exception` → exit 2 `razon=am_start_fallo`; (p4) `files/runs/<runId>/log.ndjson` no existe a los 10 s del `am start` → exit 2 `razon=run_dir_ausente`; (p5) falta `--runId` o `--scenario` → exit 2 `razon=uso_invalido`; (p6) ya existe `files/runs/<runId>/log.ndjson` antes de arrancar → exit 2 `razon=runid_repetido` (medido: reusar un `runId` mezcla la evidencia de dos corridas en el mismo directorio y el `verdict.json` viejo, que gana por `O_EXCL`, puede devolver un `ok` FALSO; nunca se borra: se rechaza). Ninguna de las seis se reporta nunca como `dead`. p2 no agrega `razon` nueva a propósito: para el host, un force-stop que no logra matar el proceso es indistinguible de un `am start` que no arrancó. El `--timeout` de A8 y las dos marcas de reloj de A9 se cuentan desde el `am start`, no desde el force-stop.
A8. **Estados finales**, mutuamente excluyentes, evaluados en este orden exacto y sólo después de A7 (review spec-1, spec-12):

| # | condición (en orden) | `estado` | `razon` | exit |
|---|---|---|---|---|
| 0 | precondición A7 (p1..p6) | `env` | `adb_ausente` \| `am_start_fallo` \| `run_dir_ausente` \| `uso_invalido` \| `runid_repetido` \| `pid_desconocido` | 2 |
| 1 | `verdict.json` con `outcome=="ok"` | `ok` | `-` | 0 |
| 2 | `verdict.json` con `outcome=="crash"` | `crash` | `data.name` del verdict | 3 |
| 3 | sin verdict, ≥15 s desde el `t` de `ev:"clock"`, `log.ndjson` sin `ev:"js_boot"` | `absent` | `js_ausente` | 7 |
| 4 | sin verdict, hay `js_boot`, `adb shell pidof dev.tasio.violeta` vacío | `dead` | `sin_pid` | 4 |
| 5 | sin verdict, pid vivo, `t` del último `hb` más viejo que 3000 ms | `wedged` | `process` | 5 |
| 6 | sin verdict, pid vivo, hb al día, `seq` del último registro `src:"js"` sin avanzar en 20 s | `wedged` | `js` | 5 |
| 7 | `--timeout` agotado con todo avanzando | `timeout` | `deadline` | 6 |

 El discriminador de la fila 3 es la existencia de `ev:"js_boot"`, no un contador de `src:"js"`: así "nunca hubo runner" (`jsSeq` inexistente) no puede confundirse con "runner congelado" (`jsSeq` presente y detenido, fila 6), y `absent` tiene exit 7 propio, distinto del 4 de `dead`. La ventana de 15 s evita declarar `absent` mientras Hermes todavía evalúa el bundle. `--timeout` se cuenta desde el `am start`.
A9. **Contrato de stdout del driver**, literal (review spec-12). Exactamente en este orden: dos marcas de reloj, luego una línea de estado por poll (1000 ms), luego exactamente una línea final.
 Líneas de reloj, literales, siempre las dos primeras (epoch ms del host, antes y después del `am start`; acotan el offset host↔device sin NTP). El `am force-stop` de A1 ocurre antes de `host_pre`, así que el par no lo incluye:
```
violeta: clock host_pre=1762000000123
violeta: clock host_post=1762000000456
```
 Línea de estado, forma fija `violeta: t=<s>s seq=<n|-> hb=<n|-> phase=<fase|-> estado=corriendo`. `estado` en esta forma vale siempre `corriendo`: los estados finales de A8 sólo aparecen en la línea final. Ejemplo literal:
```
violeta: t=12.0s seq=41 hb=12 phase=hold estado=corriendo
```
 `t` = segundos desde el `t` de `ev:"clock"` de la corrida, con un decimal. `seq` = `seq` del último registro con `src:"js"` (`-` si no hay). `hb` = `data.beat` del último registro `hb` (`-` si no hay). `phase` = `data.jsPhase` del último `hb`, o sea la última fase que el JS alcanzó a fijar (`-` si no hay).
 Línea final, forma fija `violeta: run <runId> estado=<A8> razon=<A8> evidencia=<comando|->`. Ejemplo literal de una corrida real de `selftest.block`:
```
violeta: run s3-1762000000 estado=wedged razon=js evidencia=adb exec-out run-as dev.tasio.violeta cat files/runs/s3-1762000000/log.ndjson
```
 `evidencia=` es siempre ese `cat` del `log.ndjson` de la corrida, ejecutable tal cual, sin comillas; vale `-` si el archivo no existe. En `razon=uso_invalido` el `runId` es `-`.
A10. **Tabla cerrada de `ev`** (no existe ningún otro valor; uno distinto es un bug):

| `ev` | `src` | archivo | `data` |
|---|---|---|---|
| `native_init` | native | log | `{runId,scenario,pid}` |
| `clock` | native | log | `{t}` |
| `request` | js | log | `{runId,scenario}` |
| `js_boot` | js | log | `{}` |
| `phase` | js | log | `{name}` |
| `log` | js | log | libre |
| `js_error` | js | log | `errInfo` |
| `uncaught` | native | log | `{name,message,stack}` |
| `nojs_forced` | native | log | `{}` |
| `verdict` | js | log | `{outcome}` |
| `hb` | native | heartbeat | `{beat,pid,jsPhase,jsSeq}` |

 La columna `phase` del registro es la fase vigente al emitir; para `ev:"phase"` coincide con `data.name`. `lvl` es cerrado: `info` \| `warn` \| `error`.
A11. **Fases por escenario**, nombres exactos, en orden, con tiempos fijos (review spec-10):

| escenario | fases | tiempos |
|---|---|---|
| `selftest.ok` | `boot`, `work`, `done` | `work` dura 1000 ms |
| `selftest.phases` | `boot`, `p1`, `p2`, `hold`, `done` | `p1` a los 0 ms (1000 ms), `p2` a los 1000 ms (1000 ms), `hold` de 2000 a 17000 ms (**15000 ms exactos**), `done` a los 17000 ms, verdict `ok` a los ~17100 ms. `hold` es la ventana observable de S10: cualquier evento del host entre 2000 y 17000 ms cae dentro |
| `selftest.throw` | `boot`, `throwing` | `throwing` 100 ms y luego un `Error` no atrapado |
| `selftest.block` | `boot`, `blocking` | fija `blocking` y **recién después** bloquea el hilo 30 s (por eso el último `hb` lleva `jsPhase:"blocking"`) |
| `selftest.kill` | `boot`, `killing` | `killing` y luego `VioletaObs.hardKill()` = `Process.killProcess(myPid)`, sin handler de excepción |
| `selftest.slow` | `boot`, `slow` | duerme 600 s en tramos de 100 ms y emite un `ev:"log"` cada 1000 ms: sin esos registros `seq` no avanzaría y A8.6 daría `wedged razon=js` en vez de `timeout` |
| `selftest.nojs` | ninguna | no hay JS en absoluto (A13) |

A12. **Dueño único de `verdict.json`**: lo abre siempre el writer nativo con `O_CREAT|O_EXCL` + fsync; **el primero que escribe gana y los demás son no-op silencioso**. El JS nunca toca el archivo: llama `VioletaObs.setVerdict(outcome, dataJson)`. El handler de excepción no atrapada usa el mismo camino. `ev:"uncaught"` lo emite **sólo** el handler nativo; un error de JS atrapado por el runner es `ev:"js_error"` + `setVerdict("crash", ...)`. Esquemas: `request.json` = `{"runId":string,"scenario":string,"t":number}`; `verdict.json` = `{"outcome":"ok"|"crash","t":number,"seq":number,"data":object}`. Rechazado: dos escritores con precedencia por timestamp (irresoluble si el crash y el fin normal corren a la vez).
A13. **Productor del caso "runner ausente"**: escenario `selftest.nojs`. Medición en dispositivo: la versión original (Kotlin corta `MainActivity.onCreate` antes de `super.onCreate`, sin crear el root de React) es **imposible** — Android lanza `SuperNotCalledException` y el driver lo veía como `crash` exit 3. Implementación vigente: `VioletaCore.beginRun` emite `native_init`, `clock` y `nojs_forced` cuando el escenario es `selftest.nojs`, y el runner de JS **no emite nada** para ese escenario (ni `request` ni `js_boot`). Resultado observable: `native_init` sin `js_boot` a los 15 s → `absent razon=js_ausente` exit 7, verificado. Lo que el escenario prueba es el camino de clasificación "el runner no arrancó", no la evaluación del bundle (que no se puede impedir sin romper el ciclo de vida).
A14. `UNKNOWN: si Android 16 congela el proceso cuando la activity va a background, y si eso suspende el runner JS y/o el hilo de heartbeat. Se mide en T8; los dos resultados posibles (ok, wedged razon=process) son aceptables para S10 y ninguno produce un falso ok.`
A15. `UNKNOWN: si run-as funciona en el build debug de esta app en esta tablet (el spike lo usó con otro paquete y funcionó; es el único canal de lectura). Fallback si no: espejo logcat (A4), filtrable por runId.`

## Specs

- **S1 — Esqueleto instalable.** L1: "No quiero instalar Android Studio. Build local, APK instalada por adb." Proyecto Expo bare, paquete `dev.tasio.violeta`, app "Violeta", entrypoint `App.tsx` en la raíz del repo, sin UI de chat, buildeable con el toolchain del host (hecho 1). La única pantalla renderiza el texto estático `Violeta` (L4).
  Accept: `./gradlew :app:assembleDebug` termina `BUILD SUCCESSFUL`, produce `android/app/build/outputs/apk/debug/app-debug.apk`, y `App.tsx` contiene el literal `Violeta`.
  Check (host): `cd android && ./gradlew :app:assembleDebug && ls -l app/build/outputs/apk/debug/app-debug.apk && grep -q 'Violeta' ../App.tsx && echo S1_OK`
- **S2 — Canal leíble off-device con cero interacción de UI** (req 1).
  Accept: tras una corrida, el `log.ndjson` de **ese** `runId` se lee entero desde el host sin tocar la pantalla, y la misma corrida aparece en logcat prefijada por su `runId`.
  Check (device): `RUN=s2-$(date +%s); node tools/violeta-run.ts --scenario selftest.ok --runId "$RUN" --timeout 60 && test "$(adb exec-out run-as dev.tasio.violeta cat files/runs/$RUN/log.ndjson | wc -l)" -gt 0 && test "$(adb logcat -d -s violeta:I | grep -c "$RUN .*\"ev\":\"js_boot\"")" -ge 1 && echo S2_OK`
- **S3 — Progreso leíble mientras la app está ocupada, independiente del árbol de UI** (req 2). F10: "uiautomator dump fails while the app is busy".
  Accept: durante `selftest.block` (hilo JS bloqueado 30 s) el host sigue obteniendo latidos nuevos sin usar `uiautomator`; el driver imprime ≥10 líneas de estado, el `hb=` final vale ≥10 (A6: `beat` sube de 1 en 1, 1000 ms), y termina `estado=wedged razon=js`, exit 5.
  Check (device): `RUN=s3-$(date +%s); node tools/violeta-run.ts --scenario selftest.block --runId "$RUN" --timeout 60 > s3.out; test $? -eq 5 && test "$(grep -c '^violeta: t=' s3.out)" -ge 10 && test "$(grep -o 'hb=[0-9]*' s3.out | cut -d= -f2 | sort -nu | tail -1)" -ge 10 && grep -q 'estado=wedged razon=js' s3.out && test "$(adb exec-out run-as dev.tasio.violeta cat files/runs/$RUN/log.ndjson | wc -l)" -gt 0 && echo S3_OK`
- **S4 — Progreso por fase, no un blob final** (req 3).
  Accept: `selftest.phases` emite un registro `ev:"phase"` por cada una de las cinco fases de A11, visible antes del fin de la corrida; toda línea del `log.ndjson` real tiene las claves en el orden `seq,t,mono,src,lvl,ev,phase,data`; y `mono` está en la base nativa en toda la corrida: cada registro de `src:"js"` cae en [mín `mono` nativo − 1500, máx `mono` nativo + 1500] ms, donde "nativo" son los registros de esa misma corrida con `src` distinto de `js` (A3). La holgura de 1500 ms sólo cubre el retardo entre muestrear `mono` y tomar el lock del writer; un `mono` basado en `performance.now()` o `Date.now()` cae fuera por segundos o por horas.
  Check (host): `node --test tests/record.test.ts`
  Check (device): `RUN=s4-$(date +%s); node tools/violeta-run.ts --scenario selftest.phases --runId "$RUN" --timeout 90; test "$(adb exec-out run-as dev.tasio.violeta cat files/runs/$RUN/log.ndjson | grep -c '"ev":"phase"')" -eq 5 && adb exec-out run-as dev.tasio.violeta cat files/runs/$RUN/log.ndjson | node -e 'let n=0;require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean).forEach(l=>{const k=Object.keys(JSON.parse(l)).join(",");if(k!=="seq,t,mono,src,lvl,ev,phase,data"){console.error("orden malo:",k);process.exit(1)}n++});console.log("S4_OK",n)' && adb exec-out run-as dev.tasio.violeta cat files/runs/$RUN/log.ndjson | node -e 'const L=require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean).map(s=>JSON.parse(s));const n=L.filter(r=>r.src!=="js").map(r=>r.mono);const lo=Math.min(...n)-1500,hi=Math.max(...n)+1500;const bad=L.filter(r=>r.src==="js"&&(r.mono<lo||r.mono>hi));if(bad.length){console.error("mono fuera de base nativa:",JSON.stringify(bad[0]));process.exit(1)}console.log("S4_MONO_OK")'`
- **S5 — Heartbeat escrito por un contexto que el trabajo bloqueante no puede frenar** (req 4).
  Accept: con el hilo JS bloqueado, `heartbeat.ndjson` gana **≥15** registros `hb` y el último lleva `data.jsPhase:"blocking"`, que es la última fase que el JS alcanzó a fijar antes de bloquear (A11). El umbral es 15 y no 25 por aritmética del contrato: A8.6 cierra la corrida a los ~21 s del `am start` (20 s de `seq` js congelado), así que a 1000 ms por latido hay ~20 registros, no 30.
  Check (device): `RUN=s5-$(date +%s); node tools/violeta-run.ts --scenario selftest.block --runId "$RUN" --timeout 60; test "$(adb exec-out run-as dev.tasio.violeta cat files/runs/$RUN/heartbeat.ndjson | wc -l)" -ge 15 && adb exec-out run-as dev.tasio.violeta cat files/runs/$RUN/heartbeat.ndjson | tail -1 | grep -q '"jsPhase":"blocking"' && echo S5_OK`
- **S6 — Todo silencio es atribuible: `dead` vs runner-ausente vs JS-bloqueado son tres artefactos distintos** (req 5). F9: normal / wedged / dead eran indistinguibles.
  Accept: `selftest.kill` → `estado=dead razon=sin_pid` exit 4; `selftest.nojs` → `estado=absent razon=js_ausente` exit 7 (A13, fila 3 de A8); `selftest.block` → `estado=wedged razon=js` exit 5. Tres exits distintos y tres `razon` distintas. Las tres corridas van encadenadas sobre el mismo dispositivo y cada una escribe su propio `ev:"native_init"` y su `ev:"clock"`, con el `t` de `clock` estrictamente mayor que el de la anterior (A1: force-stop antes de cada `am start`); sin eso, la segunda corrida no tendría `onCreate` y el arnés no podría distinguirla de un `run_dir_ausente` (A7 p4).
  Check (host): `node --test tests/classify.test.ts`
  Check (device): `CL=s6-$(date +%s).clock; for s in kill:4 nojs:7 block:5; do n=${s%%:*}; e=${s##*:}; RUN=s6-$n-$(date +%s); node tools/violeta-run.ts --scenario selftest.$n --runId "$RUN" --timeout 60; test $? -eq $e || { echo "S6_FAIL $n"; exit 1; }; adb exec-out run-as dev.tasio.violeta cat files/runs/$RUN/log.ndjson | node -e 'const r=require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean).map(s=>JSON.parse(s)).find(x=>x.ev==="clock");console.log(r?r.t:"nada")' >> "$CL"; done; node -e 'const a=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(Number);if(a.length!==3||!(a[0]<a[1]&&a[1]<a[2])){console.error("clock no crece entre corridas encadenadas:",a);process.exit(1)}console.log("S6_FRESH_OK")' "$CL" && echo S6_OK`
- **S7 — Una falla anterior a la existencia del runner produce artefacto** (req 6).
  Accept: `files/runs/<runId>/log.ndjson` contiene `ev:"native_init"` aun cuando el runner JS no arranque (`selftest.nojs`, exit 7); y un error de JS deja `ev:"js_error"` con `errInfo` y `verdict.json` con `outcome:"crash"` (exit 3). Medición en dispositivo: React Native intercepta los `Error` de JS con `ErrorUtils` (redbox) y el proceso no muere, así que el handler nativo **nunca** ve errores de JS; `ev:"uncaught"` queda reservado a crashes nativos (A12).
  Check (device): `RUN=s7a-$(date +%s); RUN2=s7b-$(date +%s); node tools/violeta-run.ts --scenario selftest.nojs --runId "$RUN" --timeout 60; E1=$?; node tools/violeta-run.ts --scenario selftest.throw --runId "$RUN2" --timeout 60; E2=$?; test $E1 -eq 7 && adb exec-out run-as dev.tasio.violeta cat files/runs/$RUN/log.ndjson | grep -q '"ev":"native_init"' && test $E2 -eq 3 && adb exec-out run-as dev.tasio.violeta cat files/runs/$RUN2/log.ndjson | grep -q '"ev":"js_error"' && adb exec-out run-as dev.tasio.violeta cat files/runs/$RUN2/verdict.json | grep -q '"name":"Error"' && adb exec-out run-as dev.tasio.violeta cat files/runs/$RUN2/verdict.json | grep -q '"outcome":"crash"' && echo S7_OK`
- **S8 — Append-only con `runId`; el arranque del arnés nunca borra ni reabre evidencia** (req 7). El spike hacía `rm -f` del resultado anterior.
  Accept: dos corridas con `runId` distintos dejan dos directorios completos e independientes; no existe `files/runs/latest`; en el código del arnés (Kotlin, `src/harness`, `tools`) no hay ningún borrado ni ninguna apertura en modo escritura-truncante (`rm`, `unlink`, `truncate`, `O_TRUNC`, `FileOutputStream` de un argumento, `openFileOutput(..., 0)`, `"w"`/`"wb"`).
  Check (device): `A=s8a-$(date +%s); node tools/violeta-run.ts --scenario selftest.ok --runId "$A" --timeout 60; B=s8b-$(date +%s); node tools/violeta-run.ts --scenario selftest.ok --runId "$B" --timeout 60; adb exec-out run-as dev.tasio.violeta cat files/runs/$A/log.ndjson | grep -q '"ev":"js_boot"' && adb exec-out run-as dev.tasio.violeta cat files/runs/$B/log.ndjson | grep -q '"ev":"js_boot"' && ! adb shell run-as dev.tasio.violeta ls files/runs/latest 2>/dev/null && ! grep -rnE '\brm\b|\bunlink\b|truncate|rmSync|unlinkSync|O_TRUNC|FileOutputStream\([^,)]*\)|openFileOutput\([^,]*, *(0|Context\.MODE_PRIVATE)\)|"w[b+]?"' android/app/src/main/java/dev/tasio/violeta modules/violeta-obs/android/src src/harness tools && echo S8_OK`
- **S9 — La entrega del resultado no depende de foco, toast ni scroll** (req 8). F10: "the in-app log is not auto-scrolled and its tail is hidden under a toast".
  Accept: el veredicto se obtiene leyendo archivos, no la pantalla; el comando que el driver imprime en `evidencia=` resuelve lo que dice resolver.
  Check (device): `RUN=s9-$(date +%s); node tools/violeta-run.ts --scenario selftest.block --runId "$RUN" --timeout 60 > s9.out; test $? -eq 5 && CMD=$(sed -n 's/^violeta: run .* evidencia=//p' s9.out) && test -n "$CMD" && eval "$CMD" | grep -q '"ev":"js_boot"' && echo S9_OK`
- **S10 — La corrida sobrevive que un humano use el dispositivo** (req 9). F10: "blind taps landed on other windows while the user was using the tablet".
  Accept: ni el driver ni los escenarios ejecutan `input tap`, `input swipe` ni `uiautomator`; mandar la app al background a los 5 s del `am start` —dentro de `hold`, que va de 2000 a 17000 ms (A11)— termina en `estado=ok` **o** en `estado=wedged razon=process`, nunca en `ok` falso ni en `dead`. Cuál de los dos ocurre cierra A14 y se anota en L5.
  Check (device): `! grep -rnE 'input (tap|swipe|keyevent)|uiautomator' tools src/harness App.tsx && RUN=s10-$(date +%s); (sleep 5; adb shell input keyevent KEYCODE_HOME) & node tools/violeta-run.ts --scenario selftest.phases --runId "$RUN" --timeout 90 > s10.out; grep -qE 'estado=ok razon=-|estado=wedged razon=process' s10.out && echo S10_OK`
- **S11 — Errores estructurados y secretos redactados por wrap** (req 10, la única parte que funcionó en el spike).
  Accept: todo error registrado tiene `data:{name,message,code,inner}` con `message` recortado a 300 caracteres; el valor registrado por `secret("x")` aparece como `***` en cualquier profundidad del objeto.
  Check (host): `node --test tests/errors.test.ts`
- **S12 — Escenarios de autoprueba que cubren los seis estados.**
  Accept: existen `selftest.ok`, `selftest.phases`, `selftest.throw`, `selftest.block`, `selftest.kill`, `selftest.slow` y `selftest.nojs`, con las fases y tiempos de A11, y producen respectivamente `ok`, `ok`, `crash`, `wedged`, `dead`, `timeout`, `absent` (exit 0, 0, 3, 5, 4, 6, 7).
  Check (host): `node --test tests/scenarios.test.ts`
  Check (device): `for s in ok:0 phases:0 throw:3 block:5 kill:4 slow:6 nojs:7; do n=${s%%:*}; e=${s##*:}; RUN=s12-$n-$(date +%s); node tools/violeta-run.ts --scenario selftest.$n --runId "$RUN" --timeout 40; test $? -eq $e || { echo "S12_FAIL $n"; exit 1; }; done; echo S12_OK`

Fuera de alcance, explícito: UI de chat, de transcripción o cualquier pantalla que haya que leer para obtener un resultado; cualquier llamada a NaN y cualquier manejo de API key; sesiones, herramientas y loop del agente; `isomorphic-git` y el adaptador de FS; el patch de `pi-ai` (hecho 4); iOS; build release y firma; soporte del celular (L6); nodejs-mobile; un runner de device para `node --test`; wireless debugging.

## Tasks

T1. [DONE] Orquestador: scaffold Expo bare `dev.tasio.violeta` / "Violeta", entrypoint `App.tsx` con la única pantalla de texto estático `Violeta`, gradle wrapper 9.4.1 (el cacheado en el host, ver L8), `npm install`, `assembleDebug` verde — specs: S1 — test: n/a (manual: `cd android && ./gradlew :app:assembleDebug && ls -l app/build/outputs/apk/debug/app-debug.apk && grep -q 'Violeta' ../App.tsx`) — commit: -
T2. [DONE] Contrato de esquema en TS (`src/harness/record.ts`): serializador único de A3 (orden `t,mono,src,lvl,ev,phase,data`, sin `seq`; `mono` desde un reloj inyectable `makeRecorder({mono})` con default `VioletaObs.mono()`, nunca `Date.now()`/`performance.now()`, y `tests/record.test.ts` lo verifica con un fake determinista), parser NDJSON, tabla cerrada de `ev` de A10 (incluido `clock`), `lvl` cerrado, `errInfo` estructurado y redacción por wrap de `secret()`; tests `tests/record.test.ts` y `tests/errors.test.ts` — specs: S4,S11 — test: required — commit: -
T3. [DONE] Módulo nativo Kotlin `VioletaObs` (`android/app/src/main/java/dev/tasio/violeta/`): writer único append+fsync con `seq` global y splice de A3, espejo logcat `violeta` prefijado por `runId` (A4), init en `MainApplication` (`ev:native_init`, `ev:clock`), handler de excepción no atrapada (`ev:uncaught` + `setVerdict` crash), `setVerdict` con `O_CREAT|O_EXCL` dueño único (A12), hilo daemon de heartbeat 1000 ms con `beat`/`jsPhase`/`jsSeq` volátiles (A6), `takePendingRequest()` + `request.json` desde los extras (A1, sin manejar `onNewIntent`), `mono()` síncrono que devuelve `SystemClock.elapsedRealtime()` (A3), `hardKill()` de A11, y el corto-circuito `selftest.nojs` de A13 — specs: S2,S5,S6,S7,S8 — test: n/a (no hay Kotlin en el sandbox; se verifica compilando en T4 y en device en T7/T8) — commit: -
T4. [DONE] Orquestador: puerta de compilación intermedia sin dispositivo — `assembleDebug` tras T3 y corregir lo que no compile, para que T5/T6 no esperen a la tablet — specs: S1 — test: n/a (manual: `cd android && ./gradlew :app:assembleDebug`) — commit: -
T5. [DONE] Runner headless (`src/harness/runner.ts`) + los siete escenarios de A11 con sus fases y tiempos exactos: toma el request del módulo nativo, emite `request` y `js_boot`, fija fases con `setPhase`, captura global de error JS (`ev:js_error`), emite un `log` por segundo en `slow`, cierra con `setVerdict`; `tests/scenarios.test.ts` con el módulo nativo mockeado — specs: S3,S4,S7,S10,S12 — test: required — commit: -
T6. [DONE] Driver de host (`tools/violeta-run.ts`): `--runId` y `--scenario` obligatorios, precondiciones de A7 (p1..p5: `get-state`, `am force-stop` + `pidof` vacío a los 5 s, salida de `am start`, `log.ndjson` a los 10 s, argumentos), clasificador puro de las filas 1..7 de A8 con sus exits, lectura incremental por `exec-out`/`tail -c`, stdout literal de A9 (dos marcas de reloj, línea de estado, línea final con `evidencia=`); `tests/classify.test.ts` sobre fixtures de los seis estados, de `js_ausente` y de las cuatro precondiciones — specs: S6,S8,S9,S12 — test: required — commit: -
T7. [DONE] Orquestador: `assembleDebug`, `adb install -r`, primera corrida de `selftest.ok` y `selftest.phases`; registrar si `run-as` funciona (A15) — specs: S1,S2,S4 — test: n/a (manual: `cd android && ./gradlew :app:assembleDebug && cd .. && adb install -r android/app/build/outputs/apk/debug/app-debug.apk && node tools/violeta-run.ts --scenario selftest.ok --runId t7-ok --timeout 60 && node tools/violeta-run.ts --scenario selftest.phases --runId t7-phases --timeout 90`) — commit: -
T8. [DONE] Orquestador: correr en device los Checks de S2,S3,S5,S6,S7,S8,S9,S10,S12 tal cual están escritos; cerrar A14 anotando el resultado en L5 — specs: S2,S3,S5,S6,S7,S8,S9,S10,S12 — test: n/a (manual: los Checks literales de esas specs) — commit: -

Paralelizables: T2 con T3 (tras T1); T5 con T6 (tras T2 y la puerta T4). Todo lo demás es secuencial. T7 depende de T5 y T6.

## Log
L1 (pedido original, verbatim):
"Quiero una app Android que sea un harness de IA para usar desde el celular y la tablet,
 │ con los modelos de NaN. Arranco de cero en un directorio nuevo.
 │
 │ Referencias para que mires antes de proponer nada:
 │ - /home/tasio/Documents/violeta — mi harness de escritorio, de donde quiero portar ideas
 │ - /home/tasio/Documents/android-harness/odd/tasks/spike-hermes-runtime.md — un spike mío
 │   anterior con hallazgos medidos en el dispositivo. El código lo descarto, los hallazgos no.
 │
 │ Restricciones que ya sé:
 │ - No quiero instalar Android Studio. Build local, APK instalada por adb.
 │ - Dispositivos: Lenovo Legion Tab TB323FU (arm64, Android 16) y un celular Android.
 │ - La API key de NaN la cargo yo en la app; nunca se commitea.
 │ - Es para mí solo. Perfil: personal.
 │ - Autonomía: nivel 0 al principio.
 │
 │ Primera feature, y solo esa: el arnés de test headless en dispositivo.
 │ En mi intento anterior perdí unos diez ciclos por no poder observar qué pasaba,
 │ y no quiero repetirlo.
 │
 │ No quiero: multiusuario, backend propio, sincronización en la nube, ni soporte iOS."

L2: "Vamos con todo lo que me recomendas. La tablet la conecto cuando necesites y vamos con el nombre propuesto" — aprueba stack RN/Expo+Hermes, módulo nativo Kotlin de observabilidad, alcance sólo-arnés, y `dev.tasio.violeta` / "Violeta".

L3: El orquestador creó `.ref/` con copias gitignoreadas de violeta y del spike, porque los subagentes no pueden leer fuera del proyecto.

L4 (fuera de tope (a)): la pantalla que mostraba `runId` y último `ev` se **elimina del alcance**. Leerla requeriría `uiautomator`, prohibido por S10, así que era un requisito no verificable. La app renderiza el texto estático `Violeta`. Decisión de alcance mínimo; si el usuario la quiere de vuelta, es una feature aparte con su propio canal de verificación.

L5: `PENDIENTE DE MEDICIÓN (T8)`: resultado del background con `KEYCODE_HOME` dentro de la fase `hold` — `ok` o `wedged razon=process`. Cierra A14.

L6 (fuera de tope (d)): el **celular queda fuera de esta feature** hasta nueva decisión del usuario. La app se construye y verifica sólo contra la tablet TB323FU.

L7 (ronda 1 de review, mapa de resoluciones): spec-1 → A8 fila 3 (discriminador `js_boot`, exit 7 propio); spec-2 → A7 p1..p4 (exit 2, nunca `dead`); spec-3 → A2 sin `latest` + S8 verifica modo de apertura y ausencia de `latest`; spec-4 → A13 + S12 con siete escenarios + T3/T5; spec-5 → T7 con `cd ..`; spec-6 → A12 (dueño único, esquemas, dueño de `uncaught`); spec-7 → A3 (JS serializa, Kotlin splice+`seq`); spec-8 → cada Check define su `RUN` inline y S3 no tiene `...`; spec-9 → todos los Checks usan `runId` concreto y `-ge 1`; spec-10 → A11 con `hold` de 2000 a 17000 ms + S10 acepta `ok` o `wedged razon=process`; spec-11 → A10 y A11 cerradas + ejemplos literales en A9; spec-12 → A9 con las tres formas y la tabla de A8; sugerencia y (b) ver S8/T6; (c) ver T4.

L8 (estado real del scaffold, tras T1): `expo ~58.0.22`, `react-native 0.88.1`, gradle wrapper **9.4.1** (ya cacheado en `~/.gradle/wrapper/dists` del host, así que se usa ése en lugar del 8.14.3 para no descargar nada) y `android/` versionado: se quitó `/android` del `.gitignore` del template porque el módulo nativo Kotlin es fuente de esta feature, no output generado.

L9: Dos decisiones de esta ronda. (1) El driver hace `adb shell am force-stop` antes de cada `am start` y `MainActivity` **no** maneja `onNewIntent`: `singleTask` en el manifest de `expo prebuild` haría que un segundo `am start` sobre un proceso vivo no llame `onCreate` (A1, A7 p2). (2) `mono` lo produce Kotlin y JS lo pide por llamada síncrona a `VioletaObs.mono()` (`SystemClock.elapsedRealtime()`), nunca `Date.now()`/`performance.now()`; el serializador sigue siendo único en `record.ts` y el orden de claves no cambia (A3, S4, T2/T3).

L10 (T1 verificado, 31-oct 19:47): `assembleDebug` BUILD SUCCESSFUL in 5m20s, `android/app/build/outputs/apk/debug/app-debug.apk` presente, `App.tsx` contiene `Violeta`; Check de S1 corrido tal cual → `S1_OK`. Sin dispositivo todavía. `node --test` con .ts ESM funciona sin `"type":"module"` (verificado con un test descartable), así que T2/T5/T6 no necesitan cambiar package.json.

L11 (T2/T3/T4 verificados, 31-oct ~20:40):
- T2: `node --test tests/record.test.ts tests/errors.test.ts` → 21 pass, corrido también por el orquestador; `npx tsc --noEmit` limpio tras agregar a `tsconfig.json` `types:["node"]`, `allowImportingTsExtensions` y `noEmit` (los imports `.ts` los exige el type-stripping de Node).
- T3: `VioletaObs.kt` (338 líneas), `VioletaPackage.kt` registrado en `MainApplication`, `MainActivity` con `beginRun` + corto-circuito `selftest.nojs`, `src/harness/obs.ts` (92 líneas). El handoff del worker llegó truncado; verificado por inspección de archivos, no por su reporte.
- T4 (puerta): `assembleDebug` BUILD SUCCESSFUL en 10 s con el Kotlin nuevo. Comportamiento en dispositivo: pendiente (T7/T8).
- Convenciones que el plan no fijaba y quedaron así: `phase:"-"` para registros previos al primer `ev:"phase"` (usado por `record.ts`, y T3/T5 deben usar el mismo literal); `inner` de `errInfo` sale de `cause` con fallback a `.inner`.
- Deuda anotada, no defecto: `record.ts` resuelve `mono` con su propio resolvedor lazy y `obs.ts` tiene el suyo para las otras cinco funciones; mismo contrato, dos caminos. Unificar cuando exista T5.

L12 (hueco de build encontrado al armar T7, 31-oct 20:42): el `assembleDebug` por defecto produce un APK **sin bundle JS** (el variant debug espera Metro en `localhost:8081`), así que una corrida headless sin host conectado no arrancaría el runner. Se agregó `debuggableVariants = []` en `android/app/build.gradle`, que empaqueta el bundle en el variant debug: `assets/index.android.bundle` (1.27 MB) presente y con `selftest` adentro. Se mantiene **debug** y no release porque `adb run-as` (el único canal de lectura de A5) exige `debuggable=true`; release y firma siguen fuera de alcance.

L13 (T6 verificado, 31-oct ~21:10): el driver se partió en dos porque dos workers seguidos devolvieron handoffs vacíos sin escribir nada: `tools/classify.ts` (clasificador puro, 20 tests propios) y `tools/violeta-run.ts` (CLI + adb). Suite completa: 49 tests verdes, `tsc` limpio con `tools/**` agregado al `include` de `tsconfig.json`. Sin dispositivo, el driver ya ejercita p1 y p5 end-to-end: `--scenario selftest.ok --runId dryrun-1` → `estado=env razon=adb_ausente evidencia=-` exit 2; sin argumentos → `run - estado=env razon=uso_invalido evidencia=-` exit 2.
Desvío del Kotlin respecto de A6/A10 detectado por el worker de T6: `VioletaObs` emite `jsPhase`/`jsSeq` en el nivel superior del registro `hb`, no dentro de `data`. El driver tolera ambos, pero el plan dice `data:{beat,pid,jsPhase,jsSeq}`: se corrige en el paso de fix (junto con lo que devuelva el review), no en el driver.

L14 (review de confiabilidad + fixes, 31-oct ~22:15):
Review `judge-a` (lente reliability) sobre los 8 archivos nuevos: 3 severos + 4 sugerencias, todos verificados por el orquestador contra el código antes de mandarlos a arreglar.
- severe-1: toda línea de `heartbeat.ndjson` era JSON inválido (`data` cerrada después de `pid`, `jsPhase`/`jsSeq` fuera, y `jsSeq` interpolado sin comillas). Efecto: el driver moría con exit 1 en la primera corrida real. ARREGLADO: `data:{beat,pid,jsPhase,jsSeq}` con `jsSeq` número o `null`; línea validada con `JSON.parse` para los casos null y numérico.
- severe-2: `ahoraMono` era el máximo `mono` leído, así que con el dispositivo en silencio total la brecha se congelaba y siempre daba `timeout` en vez de `wedged razon=process` / `absent razon=js_ausente`. ARREGLADO: ancla `{mono, host}` fijada en el primer `ev:"clock"`, `ahoraMono = ancla.mono + max(0, Date.now() - ancla.host)`; sin ancla no se clasifica.
- severe-3: `spawnSync` sin `timeout` → un adb colgado congelaba el driver para siempre. ARREGLADO: `ADB_TIMEOUT_MS = 15000`, 1 reintento y `FalloTransporte` → `env` exit 2.
- sugerencias aplicadas: pidof con error de transporte ya no produce `dead` (2 polls vacíos confirmados, `env` a los 10 s si persiste); handler de excepción reinstalado desde `MainActivity` después de `super.onCreate` (y no-op si ya es el nuestro); `runHeadlessOnce` entero dentro del try + `.catch()` en `App.tsx`; `faseDeHb` lee sólo `data.jsPhase`.
- Efecto colateral detectado y corregido por el orquestador: el fix de severe-3 usó una *parameter property* de TS (`constructor(readonly detalle: string)`), sintaxis que el strip-only de Node 24 rechaza → el driver quedó inejecutable (exit 1 con `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). Reemplazado por propiedad + asignación explícita. Verificado: `--scenario selftest.ok --runId dryrun-2` → `estado=env razon=adb_ausente` exit 2; sin argumentos → `estado=env razon=uso_invalido` exit 2.
Estado tras L14: 49 tests verdes, `tsc` limpio, `assembleDebug` BUILD SUCCESSFUL con el Kotlin corregido. Sigue faltando el dispositivo para T7/T8.

L15 (verificación en dispositivo, TB323FU / Android 16 / arm64, 31-oct 22:20-22:45). Todo lo de abajo se midió ejecutando, no leyendo código.
- Instalación y `run-as`: funcionan (A15 no hace falta: el fallback por logcat queda sin usar).
- T7: `selftest.ok` → `estado=ok` exit 0. `selftest.phases` → `estado=ok` exit 0, 5 registros `ev:"phase"`, orden de claves `seq,t,mono,src,lvl,ev,phase,data` verificado sobre el archivo real, y el progreso se ve en vivo mientras corre (`hold` de 15000 ms con `hb` avanzando y `seq` de JS congelado: requisito 4 probado en dispositivo).
- T8: los siete escenarios dan el exit esperado (ok 0, phases 0, throw 3, block 5, kill 4, slow 6, nojs 7). S8 verde (dos corridas con evidencia separada, sin `latest`, sin aperturas truncantes). S9 verde (el comando de `evidencia=` corre tal cual y devuelve el `js_boot` de esa corrida). S10 verde con `KEYCODE_HOME` a los 5 s: `estado=ok`, así que Android 16 **no** congela el proceso al mandarlo al fondo → A14 cerrado.
- Defectos encontrados y corregidos AL VERIFICAR (ninguno era visible sin dispositivo):
  1. El módulo nativo legacy (`ReactContextBaseJavaModule`) **no era visible desde JS** en modo bridgeless: `native_available=false` y el runner no escribía nada. Migrado a Expo Module (`modules/violeta-obs`, `requireNativeModule`). El contrato (sincronía de `mono`/`append`, `fsync` por registro) no cambió.
  2. Cada línea de `heartbeat.ndjson` era JSON inválido (llaves de más y `jsSeq` sin comillas) → corregido antes de la primera corrida exitosa (review severe-1).
  3. El driver moría con exit 1 cuando `tail` devolvía texto de error: `exec-out` mezcla stderr en stdout y el archivo no existe durante los primeros milisegundos. Ahora se filtran las líneas que no empiezan con `{` y el offset avanza por bytes crudos.
  4. `pidof` devuelve code 1 con salida vacía cuando no hay proceso (no es un error de transporte): el caso `dead` se reportaba como `env razon=adb_ausente`. Corregido; el pid realmente desconocido ahora usa `razon=pid_desconocido`.
  5. `selftest.nojs` cortaba `MainActivity.onCreate` antes de `super.onCreate` → `SuperNotCalledException` (ver A13 corregida).
  6. `selftest.throw` daba `wedged razon=js` exit 5: React Native se traga los `Error` de JS. Ahora el escenario lanza dentro del dispatcher y deja `js_error` + veredicto `crash` (ver S7 corregida).
  7. Reusar un `runId` mezclaba evidencia y podía devolver un `ok` falso: agregada la precondición p6 `runid_repetido` (ver A7).
  8. `existeRemoto` daba falso positivo (la salida de `ls` de un archivo inexistente contiene el nombre del archivo) → ahora compara la línea exacta. Afectaba también p4.
- Estado final: 49 tests verdes, `tsc` limpio, `assembleDebug` verde, siete escenarios y los tres checks de dispositivo verdes.
