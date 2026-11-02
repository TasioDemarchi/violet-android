# Scout brief — sandbox capability + prior observability design

## JOB A — what THIS sandbox can do (workers here must build an Android app)

- Network: open, no proxy. dl.google.com maven 200, repo1.maven.org 200, registry.npmjs.org 206, services.gradle.org 307, git-over-HTTPS works. api.nan.builders 401 with the key in env (irrelevant: the user types his own key in the app).
- Filesystem: HARD-CONFINED to the project dir. Every path outside is refused by the harness: "El acceso fuera del proyecto (<path>) necesita un permiso y no hay UI para pedirlo."
  - `/tmp` NOT usable, `$HOME` NOT usable, `~/.gradle` and `~/Android/Sdk` NOT visible.
  - `curl -o /dev/null` refused (any /dev/null helper fails). `rm -f` blocked; plain `rm` allowed.
- Toolchain present: java/javac/keytool/jar (Temurin 21.0.5), node 24.21.0, npm 11.19.0, git 2.43.0, curl, unzip, python3.
- Toolchain ABSENT: gradle, adb, sdkmanager, aapt/aapt2/d8/zipalign/apksigner.
- Consequence: NO build, NO install, NO device run inside the sandbox. The orchestrator (outside the sandbox) runs gradle + adb.
- Env: PI_PROVIDER=nan, PI_MODEL=deepseek-v4-flash, PI_CODING_AGENT=true. ANDROID_*/GRADLE_* unset.

## JOB B — prior observability design (.ref/spike/)

### 1. Mechanism of the previous headless run
- Two files in app private dir: autotest-request.json in (autotest.ts:18), spike-result.json out (:19).
- In-app trigger is a polling watcher: setInterval(..., 2000) checks REQ.exists, deletes, runs (autotest.ts:285-291). No intent/IPC/broadcast.
- Host -> device: base64 the JSON arg, `adb shell run-as <pkg> sh -c 'base64 -d > files/autotest-request.json'` (adb-autotest.sh:54-55) because "no shell quoting can strip it".
- Read-back verification: run-as cat the request, strip whitespace, compare, fail loudly (adb-autotest.sh:58-66).
- Result: flush() serialises the whole object after every step status change (autotest.ts:51-59, called :80-88).
- Liveness: 2 s setInterval rewrites heartbeat {at, progress, lastOp, opCounts} (autotest.ts:258-262).
- Host polls every 3 s (adb-autotest.sh:14), prints one compact line (done= steps=[...] progress= lastOp= at=) (:69-86), success on "done":true (:100), timeout -> STALLED (:107-117).
- Lifecycle: am force-stop + am start (:33-34), pidof loop <=15 s (:37-47), fixed sleep 5 (:48-49), then run-as rm -f of stale files (:52).

### 2. Recorded failures
- F9: last log line "Analyzing workdir 1", then 90 s of nothing at ~7% CPU. Whether it progressed was "never observed reliably". Normal / wedged / dead were indistinguishable.
- F10 (the real blocker was observability, not code; ~10 cycles wasted):
  1. uiautomator dump fails while the app is busy.
  2. console.log does not reach logcat in the dev build — 0 events in two 10-minute monitors: no JS log channel at all.
  3. In-app log does not auto-scroll; tail hidden under a toast.
  4. Blind taps landed on other windows while the user was using the tablet.
- F11: once instrumented, the medium clone took 17.7 s with phases receive 5.2 / resolve 10.3 / analyze 14.0 / checkout 17.4 (764 files) — the F9 "stall" was observability noise.
- F8: a later session re-attributed a failure without re-reading the record; lost state produced a wrong diagnosis.

### 3. What that design did NOT solve
- App crash / process death after startup: pidof is checked once at t~0; later death yields the same text as "watcher never ran".
- JS exception before the watcher exists (module-eval error): only run() is wrapped; import-time throw -> no file, no logcat -> total silence.
- No logcat from JS at all: the sole channel is a file the app must successfully write; flush has no failure path.
- Heartbeat on the same JS thread as the awaited native call: a synchronously blocking native bridge stalls the clock identically to a hang.
- No terminal/hang signal; no watchdog, no abort, no stack dump.
- Destructive start (rm -f of prior artifacts) + single fixed filename with no run id: prior evidence destroyed, two runs indistinguishable.
- No host<->device time correspondence.
- Screen lock / device state unhandled.
- No fallback for uiautomator under load; blind taps invalid when a human shares the device.

### 4. Observability requirements implied by those failures (no invention)
1. A log channel readable off-device with zero UI interaction.
2. Progress readable while the app is busy, independent of the UI tree.
3. Progress emitted per phase, not one final blob.
4. A heartbeat written by a context the blocking work cannot stall, so "hung" != "slow".
5. Any silence must be attributable: process-dead vs watcher-absent vs JS-blocked = three distinct artifacts.
6. Failures before the watcher exists must still produce an artifact.
7. Artifacts append-only with a run id, never cleared by the harness start.
8. Result delivery must not depend on focus, toast layering or scroll position.
9. A run must survive the device being used by a human: no blind taps, no exclusive-focus assumption.
10. Errors structured (name/message/code/inner); secrets redacted by wrap, not omission (the one part that worked).
