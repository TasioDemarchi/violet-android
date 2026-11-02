# CONTINUAR — traspaso a una sesión nueva de IA

Este archivo existe para que otra IA (o vos mismo dentro de tres meses) retome el proyecto
**sin hacer preguntas**. Leelo entero antes de tocar nada. Al final está el texto exacto
que hay que pegarle a la IA nueva.

---

## 1. Qué es esto y para quién

Violeta: una app Android que es un arnés de IA personal, para usar desde el celular y la
tablet, con los modelos de NaN. Un dueño, sin backend, sin nube, sin usuarios, sin iOS.
La API key de NaN la carga el dueño en la app y nunca se commitea.

Contexto del dueño: **poca base técnica sobre el código**; juzga resultados, tiempo, costo
y riesgo. Pide explicaciones en lenguaje natural y prefiere que se le recomiende una opción
en vez de un menú.

## 2. Estado real (al 1 de noviembre de 2026, ~02:00 ART)

### Feature 1 — arnés de test headless: TERMINADA Y VERIFICADA EN TABLET

- La app arranca, escribe un log NDJSON por corrida con `seq` global, un heartbeat de
  1000 ms en un hilo nativo, captura de excepciones y un `verdict.json` con dueño único.
- Un driver en la compu (`tools/violeta-run.ts`) lanza una corrida por `adb`, la vigila y
  dictamina uno de **siete** estados: `ok`(0), `env`(2), `crash`(3), `dead`(4),
  `wedged`(5), `timeout`(6), `absent`(7).
- Verificado en la tablet (Lenovo Legion Tab TB323FU, Android 16, arm64): los siete
  escenarios de `selftest.*` dan el estado esperado; dos corridas no se pisan; el comando
  de `evidencia=` corre tal cual; mandar la app al fondo no rompe la corrida (Android 16
  **no** congela el proceso: A14 del plan quedó cerrado); `run-as` funciona.
- Registro completo con mediciones: `odd/tasks/headless-test-harness.md` (A1-A15, S1-S12,
  L1-L15). Reviews: `odd/reviews/`.

### Feature 2 — motor con NaN: implementada, DOS corridas finales pendientes

- Hecho y con tests de host: almacén de la key (`src/nan/key.ts`), cliente del provider
  (`src/nan/cliente.ts` + `modelo.ts`), herramienta `hora_actual` y bucle acotado
  (`src/nan/herramientas.ts`), pantalla de chat (`src/app/chat.tsx`) y composition root
  (`App.tsx`).
- Verificado **en la tablet** con el arnés: `nan.sin-key` → `ok` (corta antes de cualquier
  request) y `nan.http-error` → `ok` (status 500, el cuerpo del provider no se filtra).
- **Pendiente, y es lo único que falta para cerrar la feature:** `nan.stream` y `nan.tool`
  en la tablet. No se pueden correr hasta que el dueño pegue la key en la app (ver §3).
- Plan y estado: `odd/tasks/agent-runtime-nan.md` (A1-A12, S1-S11, L1-L5).

### Verificación de host al momento del traspaso

```
npm test            → 74 tests, 0 fallan
npx tsc --noEmit    → limpio
assembleDebug       → BUILD SUCCESSFUL
```

## 3. Lo único que falta, en orden

1. **El dueño pega la key en la tablet**: abrir Violeta → Abrir chat → pegar la key en
   "API key de NaN" → Guardar. La key va al Keystore (`violeta.nan.apiKey`). Después de
   esto, la IA no necesita (ni debe pedir) la key.
2. Correr, desde la raíz del repo con la tablet conectada:

```bash
node tools/violeta-run.ts --scenario nan.stream --runId "nan-stream-$(date +%s)" --timeout 120
node tools/violeta-run.ts --scenario nan.tool   --runId "nan-tool-$(date +%s)"   --timeout 120
```

   `nan.stream` espera `ok` con ≥2 deltas y 1 request. `nan.tool` espera `ok` con
   exactamente 2 requests y que la respuesta mencione la hora devuelta por la herramienta.
3. Si alguna falla: el `log.ndjson` de esa corrida (comando impreso en `evidencia=`) dice
   en qué paso quedó. No adivinar: leer el log.

## 4. Mapa del código (qué hace cada archivo)

```
App.tsx                       composition root: única entrada a expo/fetch, SecureStore y
                              pi-ai; arranca el arnés headless y monta la pantalla
src/app/chat.tsx              pantalla de chat (sin router): key, mensaje, streaming
src/nan/key.ts                almacén de la key como puerto inyectable; literal de falta de key
src/nan/modelo.ts             literal del modelo NaN (deepseek-v4-flash)
src/nan/cliente.ts            streamSimple, fetch inyectable, timeout, abort, error HTTP
src/nan/herramientas.ts       hora_actual + bucle acotado a una ronda
src/harness/record.ts         serializador NDJSON con tabla CERRADA de 11 eventos
src/harness/obs.ts            shim tipado del módulo nativo
src/harness/runner.ts         runHeadlessOnce + mapa SCENARIOS + escenarios selftest.*
src/harness/scenarios-nan.ts  escenarios nan.* (se esparcen en el mapa; el driver no cambia)
tools/violeta-run.ts          driver de host: precondiciones, lectura incremental, veredicto
tools/classify.ts             clasificador puro de los estados finales (testeable sin device)
scripts/patch-pi-ai.mjs       parche de pi-ai para Metro (4 sitios), postinstall, idempotente
modules/violeta-obs/          Expo Module Kotlin: writer+fsync, seq, logcat, heartbeat,
                              handler de excepción, verdict con O_CREAT|O_EXCL
android/                      proyecto nativo VERSIONADO (el módulo Kotlin es fuente)
odd/                          planes, reviews, notas: la memoria del proyecto
```

## 5. Decisiones tomadas y por qué (NO re-abrir sin motivo nuevo)

- **React Native + Expo 58 / RN 0.88 / Hermes**, no Kotlin nativo: reusa `pi-ai` y el
  port del harness de escritorio; probado en dispositivo.
- **Módulo nativo como Expo Module** (`modules/violeta-obs`), no `ReactContextBaseJavaModule`:
  el módulo legacy **no es visible desde JS** en modo bridgeless; medido (`native_available=false`).
- **APK debug con `debuggableVariants = []`**: `adb run-as` exige debuggable, y el JS va
  adentro del APK para no depender de Metro. El release/firma está fuera de alcance.
- **`android/` versionado**: el módulo nativo es fuente, no output.
- **Writer único con `seq` global** y `fsync` por registro; `verdict.json` con
  `O_CREAT|O_EXCL` (el primero gana). Nada de aperturas truncantes (S8 lo verifica).
- **Heartbeat en hilo nativo** (no en JS): es lo que distingue "colgado" de "muerto".
- **Estados por precedencia**, y "silencio" siempre atribuible: `dead` (no hay pid),
  `absent` (no hay `js_boot`), `wedged razon=js|process`, `timeout`.
- **`runId` obligatorio y único**: reusarlo mezcla evidencia y puede devolver un `ok`
  falso; el driver lo rechaza con `env` exit 2 (`razon=runid_repetido`).
- **Key como puerto inyectable**: `src/nan/key.ts` no importa Expo; el almacén seguro
  entra por parámetro desde `App.tsx`. Es lo que permite que los tests corran en Node.
- **`fetch` inyectable** (`expo/fetch` desde `App.tsx`): el `fetch` global de RN no streamea.
- **Una sola herramienta** (`hora_actual`): devuelve un dato que el modelo no puede
  inventar, así el segundo turno prueba que la ejecución ocurrió de verdad.
- **Bucle acotado a una ronda de herramienta**: sin historial ni guardias, un modelo
  insistente colgaría la app.
- **Cero eventos nuevos en el NDJSON**: `log.data = {evt, ms, n}` y `status` sólo en
  `nan.error`. La respuesta del modelo y la key no se registran nunca.
- **Idioma**: el proyecto (docs y comentarios) está en español; el dueño lee en español.

## 6. Trampas ya pagadas (leer antes de depurar)

1. **Hermes no tolera asignar a un `let` diferido dentro de un `Promise` executor**
   (`Property 'x' doesn't exist`). Node sí. Costó una corrida fallida.
2. **React Native intercepta los `Error` de JS con `ErrorUtils`**: el handler nativo de
   excepción nunca los ve. Un error de JS se registra como `js_error` + verdict `crash`.
3. **`adb exec-out` mezcla el stderr del device en stdout**: si el archivo no existe,
   llegan líneas como `tail: ...: No such file`. El driver filtra líneas que no empiezan
   con `{` y sólo avanza el offset si hubo al menos una.
4. **`adb shell` devuelve 0 aunque el comando del device falle** y `ls` de una ruta
   inexistente imprime el nombre de la ruta: la existencia se decide comparando la línea
   exacta, no por código de salida ni por "salida no vacía".
5. **`pidof` sale con code 1 y salida vacía cuando no hay proceso** (no es error de
   transporte). Confundirlos reportaba `dead` como `env`.
6. **Metro rechaza `import(<variable>`**. pi-ai 1.4.0 lo usa en 4 sitios; `scripts/patch-pi-ai.mjs`
   los reemplaza por un rechazo explícito y **falla con exit 1 si un ancla desaparece**
   (un bump de pi-ai puede reintroducirlo).
7. **`singleTask` en el manifest**: un `am start` sobre un proceso vivo no llama
   `onCreate`. Por eso el driver hace `am force-stop` antes de cada corrida.
8. **No dejar que la app se ejecute sin el módulo nativo**: si `isNativeAvailable()` es
   `false`, no hay artefactos posibles. Sale por logcat con el tag `ReactNativeJS`.
9. **`tsconfig.json` incluye `src/**/*.tsx`**: sin eso `npx tsc --noEmit` no revisa la
   pantalla.

## 7. Cómo se levanta el entorno en una máquina nueva

Requisitos (versiones que funcionaron):

- **Node 24** (22+ sirve; los tests usan type-stripping nativo, `.ts` importado con extensión).
- **JDK 21** (Temurin). Gradle no se instala: se usa el wrapper del repo (9.4.1).
- **Android SDK** con `platform-tools`, `platforms;android-36`, `build-tools;36.0.0` y
  `ndk;27.1.12297006` (React Native compila C++). Sin Android Studio.
- **adb** en el PATH o `ANDROID_HOME` definido (`platform-tools/adb`).

Pasos:

```bash
git clone https://github.com/TasioDemarchi/violet-android.git
cd violet-android
echo "sdk.dir=/ruta/al/Android/Sdk" > android/local.properties
npm install                 # corre postinstall → scripts/patch-pi-ai.mjs
npm test                    # 74 tests
npx tsc --noEmit
cd android && ./gradlew :app:assembleDebug && cd ..
adb devices                 # la tablet tiene que aparecer como "device"
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Para habilitar la tablet: Ajustes → Opciones de desarrollador → Depuración USB; conectar
por USB y aceptar el diálogo "¿Permitir depuración USB?" en la tablet.

## 8. Cómo se trabaja este repo

- El dueño trabaja con **modo ODD**: primero un documento de plan en `odd/tasks/` (specs con
  criterio observable y comando de verificación, tareas chicas), revisión independiente
  antes de escribir código, y después ejecución tarea por tarea con la evidencia pegada.
- **Los subagentes no ven nada fuera del repo**: no tienen `adb`, ni `gradle`, ni el SDK.
  Todo build, instalación o corrida en dispositivo lo hace el agente principal.
- Las herramientas de compilación corren **en la máquina del dueño**, y la tablet es el
  único dispositivo soportado (el celular quedó fuera de alcance a pedido del dueño).
- Antes de dar algo por hecho: `npm test`, `npx tsc --noEmit`, `assembleDebug`, y si toca
  dispositivo, la corrida real con el arnés. Nunca afirmar que un comando pasó sin verlo.

## 9. Incógnitas y deudas conocidas

- El texto de los mensajes de pantalla de la key ("Key guardada.", "Key borrada del
  dispositivo.") **no tiene verificación automática**: es inspección manual.
- `nan.tool` exige que la respuesta mencione la hora con precisión de minutos; si el modelo
  reformula la hora (por ejemplo "las 3 y cuarto"), el escenario falla aunque todo funcione.
  En ese caso, ajustar la aserción a la zona o a un fragmento del `iso`, no el motor.
- El proyecto no tiene historial de conversaciones ni sesiones: cada mensaje es independiente.
- `Intl` en Hermes puede no resolver zonas raras; `relojDelSistema()` cae a `"desconocida"`.
- El harness de escritorio (`~/Documents/violeta`) y el spike viejo
  (`~/Documents/android-harness`) **ya no existen**: sus hechos útiles están resumidos en
  `odd/notes/` y en `odd/tasks/`.

---

## 10. Prompt para pegarle a la IA nueva

Copiá y pegá esto tal cual, en una sesión nueva, con el repo clonado y abierto:

```
Estás retomando un proyecto mío que ya está empezado y anda. Leé, en este orden y
completo, antes de escribir nada:

1. CONTINUAR.md
2. README.md
3. odd/tasks/headless-test-harness.md  (la feature 1, terminada)
4. odd/tasks/agent-runtime-nan.md      (la feature 2, casi terminada)
5. odd/notes/pi-ai-api.md y odd/notes/observabilidad.md

Reglas para vos:
- Trabajás en español conmigo y me explicás en lenguaje natural, sin darte por
  sobreentendido. Si vas a usar un término técnico, lo explicás en una línea.
- Antes de cambiar algo: me decís qué vas a hacer y por qué, en dos o tres líneas.
  Yo apruebo. No quiero sorpresas ni cambios de alcance que yo no pedí.
- Después de cambiar algo: corrés lo que haya que correr y me mostrás el resultado real.
  Nunca me digas que algo pasó si no lo viste.
- No me preguntes por cosas que ya están decididas en CONTINUAR.md. Si algo no está,
  preguntame una sola cosa por vez, en lenguaje de resultado, no de código.
- Los subagentes no tienen adb, ni gradle, ni el SDK: los builds y las cosas en la
  tablet las hacés vos.

Lo único que falta ahora es correr en la tablet los dos escenarios que dependen de NaN
(nan.stream y nan.tool) después de que yo pegue la key en la app. Empezá por explicarme
en cuatro líneas qué vas a hacer y qué esperás ver.
```
