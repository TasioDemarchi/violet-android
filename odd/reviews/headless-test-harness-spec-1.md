# judge-b · lens spec · ronda 1 — headless-test-harness

Sobre `odd/tasks/headless-test-harness.md` antes de la primera escritura de fuente.

## Severos (10)

- **spec-1** `:36 (A7) vs :59 (S6) y :62 (S7)` — `razon=js_ausente` no existe como rama en A7: "cero registros src:js" no está definido como "no avanzó" ni como estado propio; comparte exit 4 con `dead`, así que dos de los tres silencios de F9 colapsan otra vez. Fix: rama nueva en A7 con su posición y exit code propio, o campo discriminatorio (`jsSeq` ausente ≠ congelado).
- **spec-2** `:36 (A7 regla 2), :30 (A1)` — `pidof` vacío se clasifica `dead` sin distinguir "arrancó y murió" de "nunca arrancó": si `am start` falla, paquete no instalado o adb sin dispositivo, el driver reporta `dead exit 4`, que es la lectura que costó los diez ciclos. Fix: precondición previa a las cinco reglas (fallo de `am start`, adb ausente, ausencia de `files/runs/<runId>/` tras N s ⇒ exit 2, `razon` propia), nunca `dead`.
- **spec-3** `:31 (A2) vs :65 (S8)` — A2 reescribe `files/runs/latest` en cada arranque; S8 prohíbe reabrir en `w` un artefacto previo. Incompatibles. Además el Check de S8 busca sólo verbos (`rm|delete|unlink|truncate`), así que un `open(w)` pasaría. Fix: excluir `latest` explícitamente en S8 o pasar a append de una línea por corrida; verificar modo de apertura, no sólo greps.
- **spec-4** `:62 (S7), :59 (S6), :77 (S12), :86-91` — el caso "native_init sin js_boot" no tiene productor: S12 lista seis escenarios y ninguno deja el bundle sin evaluar; T6/T7 no lo corren; el Check de S6 nombra un tercer escenario inexistente. Fix: decidir el artefacto (`selftest.nojs` reconocido por la init nativa, o segundo APK/flag), nombrarlo en S12 y asignarlo a una tarea.
- **spec-5** `:90 (T6)` — el comando manual no corre tal cual: tras `cd android`, `node tools/violeta-run.ts` se resuelve contra `android/tools/`, que no existe. Fix: dos pasos, o `cd ..` explícito.
- **spec-6** `:38 (A9) vs :88 (T4)` — `verdict.json` tiene dos escritores declarados (handler nativo y runner JS) sin precedencia, y no hay esquema de `verdict.json` ni de `request.json`; `ev:"uncaught"` tampoco tiene dueño único. Fix: un dueño por fuente con verificación de existencia, y esquema mínimo publicado.
- **spec-7** `:32 (A3) vs :53 (S4), :87 (T3)` — A3 pone la serialización NDJSON en Kotlin; T3/S4 la ponen en `src/harness/record.ts` y prueban el orden de claves con `node --test`. Si serializa Kotlin, el único test automatizable no prueba el archivo real. Fix: fijar la frontera (¿JS produce el string y Kotlin sólo append+fsync?) y reescribir S4/T3.
- **spec-8** `:49, :54, :57, :63` — cuatro Checks usan `$RUN`, que nada define ni publica; el Check de S5 tiene un `...` literal, o sea no es ejecutable. Fix: definir el mecanismo (p. ej. `RUN=$(adb exec-out run-as … cat files/runs/latest)`), expandir S5 completo.
- **spec-9** `:49 (S2), :65 (S8)` — dos Checks dependen de cuántas corridas hubo antes: `logcat | grep -c js_boot` sólo da 1 en la primera corrida de la sesión; `ls files/runs | wc -l` da 3 sólo si la corrida es la segunda de la historia, y T7 corre seis. Fix: aserciones sobre `runId` concretos (existencia + log no vacío), grep acotado por `runId`.
- **spec-10** `:71 (S10) vs :39 (A10)` — S10 exige `estado=ok` tras `KEYCODE_HOME` mientras A10 declara UNKNOWN justamente eso y anticipa `wedged razon=process`. T7 no puede cerrar A10 y pasar S10 a la vez si Android 16 congela. Además "a mitad de la corrida" no es observable: ninguna spec fija la duración de `selftest.phases`. Fix: aceptar `{ok, wedged razon=process}` y fijar una fase `hold` de duración conocida.

## Sugerencias (2)

- **spec-11** `:56-58, :53-55, :32` — S5 Accept dice "congelada en la fase previa al bloqueo" y su Check exige `"jsPhase":"blocking"`: dos afirmaciones opuestas. Falta la tabla cerrada de valores de `ev` y los nombres de las fases.
- **spec-12** `:36, :37, :50, :68` — contrato de stdout del driver sin definir: `razon=` obligatorio para los cinco estados pero sólo definido para `wedged`; forma de la "línea de estado" de S3; contenido de `evidencia=`; posición de las marcas de reloj de A8; y `ev:"clock"` no está en T2.

## Fuera del tope (sin bloquear)

(a) S1 Accept pide pantalla con `runId` y último `ev`, pero ninguna tarea la produce y su Check sólo hace `assembleDebug`. (b) El grep de S8 omite `tools/`, donde vive el driver. (c) T2 es el único Kotlin y no hay compilación intermedia sin dispositivo: un `assembleDebug` temprano abarata el ciclo. (d) L1 nombra tablet y celular; el plan excluye el celular sin aprobación explícita.
