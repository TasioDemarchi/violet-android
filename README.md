# Violeta

Una app Android que es un arnés de IA para usar desde el celular y la tablet, con los
modelos de NaN. Es personal: no tiene usuarios, ni servidor propio, ni nube, ni versión
para iPhone.

El proyecto está en dos partes terminadas y una en curso:

1. **El arnés de test headless** — la app puede correr pruebas sola, en la tablet, y
   contarte desde la compu qué pasó, sin que tengas que tocar la pantalla. **Terminado y
   verificado en la tablet.**
2. **El motor con NaN** — la app habla con el modelo, muestra la respuesta mientras se
   escribe, y ejecuta una herramienta. **Terminado salvo dos pruebas finales**, que
   necesitan que vos pegues tu key (ver "La key de NaN" más abajo).

## Cómo se abre

En la tablet: el ícono **Violeta**. La pantalla principal muestra "Violeta" y un botón
**Abrir chat**.

- **Abrir chat** lleva a la conversación: un campo para la API key, un campo para el
  mensaje y el texto de la respuesta, que aparece de a partes mientras el modelo escribe.
- No hay más pantallas: es a propósito, la app todavía no es un producto, es el motor y
  su instrumento de medición.

## La key de NaN

La key se carga **en la app**, una sola vez:

1. Abrí el chat.
2. Pegá la key en el campo *API key de NaN*.
3. Tocá **Guardar**. Aparece "Key guardada.".
4. Con **Borrar key** se elimina del dispositivo.

Se guarda cifrada en el almacén del sistema (Keystore) bajo el nombre `violeta.nan.apiKey`.
**Nunca** se escribe en un archivo del proyecto, ni en un registro, ni viaja en un commit.

## Dónde viven los datos

Todo lo que produce una corrida queda **dentro de la app**, en su almacenamiento privado,
un directorio por corrida:

```
files/runs/<runId>/log.ndjson        lo que fue pasando, en orden
files/runs/<runId>/heartbeat.ndjson  el latido del proceso, cada segundo
files/runs/<runId>/request.json      qué escenario se pidió
files/runs/<runId>/verdict.json      cómo terminó
```

Con la tablet conectada por USB, desde la compu:

```bash
adb exec-out run-as dev.tasio.violeta ls files/runs
adb exec-out run-as dev.tasio.violeta cat files/runs/<runId>/log.ndjson
```

**Cómo se respalda:** esas carpetas son la evidencia. Para copiarlas a la compu:

```bash
adb exec-out run-as dev.tasio.violeta tar -cf - files/runs > runs.tgz
```

No se borran nunca solas: cada corrida usa un `runId` nuevo y la app no borra nada. Para
liberar espacio hay que borrarlas a mano, y eso pierde la evidencia de esas corridas.

## Cómo se corre una prueba

Desde la compu, con la tablet conectada:

```bash
node tools/violeta-run.ts --scenario selftest.ok --runId "prueba-$(date +%s)"
```

Escribe una línea por segundo mientras corre y termina con un veredicto. Los resultados
posibles, cada uno con su código de salida:

| estado | significado | sale con |
|---|---|---|
| `ok` | terminó bien | 0 |
| `env` | problema de entorno (sin tablet, la app no arrancó, `runId` repetido) | 2 |
| `crash` | la app avisó un error | 3 |
| `dead` | el proceso se murió | 4 |
| `wedged` | quedó colgada (el `razon=` dice si fue el proceso o el JavaScript) | 5 |
| `timeout` | se agotó el tiempo y seguía trabajando | 6 |
| `absent` | nunca arrancó el motor de JavaScript | 7 |

Escenarios disponibles hoy: `selftest.ok`, `selftest.phases`, `selftest.throw`,
`selftest.block`, `selftest.kill`, `selftest.slow`, `selftest.nojs`, `nan.stream`,
`nan.tool`, `nan.sin-key`, `nan.http-error`.

## Cómo se compila e instala

No hace falta Android Studio: se compila con Gradle y se instala con `adb`.

```bash
npm install                                  # instala deps y parchea pi-ai para Metro
cd android && ./gradlew :app:assembleDebug   # genera el APK
cd .. && adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Si es la primera vez en esta compu, antes hay que crear `android/local.properties` con:

```
sdk.dir=/ruta/a/tu/Android/Sdk
```

El APK es **debug** a propósito: `adb run-as`, que es el único canal para leer los
archivos de la app, exige que sea debuggable. Pero el JavaScript va **adentro** del APK,
así que la app funciona sin Metro encendido.

## Tests y verificación

```bash
npm test          # 74 tests de host (node --test)
npx tsc --noEmit  # typecheck
```

## Lo que esta app NO hace

Multiusuario, backend propio, sincronización en la nube, iPhone, historial de
conversaciones, varias conversaciones, subagentes, herramientas de archivos o shell,
ajustes de modelo en la interfaz, versión release firmada.

## Documentación interna

- `odd/tasks/headless-test-harness.md` — el plan y los resultados del arnés (la feature 1),
  con las mediciones hechas en la tablet.
- `odd/tasks/agent-runtime-nan.md` — el plan del motor (feature 2) y su estado.
- `odd/reviews/` — las revisiones independientes que se corrieron.
- `odd/notes/` — hechos verificados sobre pi-ai y sobre cómo observar una corrida.
- `CONTINUAR.md` — **si retomás esto con una IA, empezá por ahí**: incluye el texto que hay
  que pegarle.
