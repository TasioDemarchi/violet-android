package expo.modules.violetaobs

import android.content.Context
import android.os.Process
import android.os.SystemClock
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Núcleo nativo de observabilidad del arnés (T3, A2/A3/A4/A6/A12).
 *
 * Es estado de proceso, no de instancia: la corrida se liga en el arranque
 * (MainActivity.onCreate) antes de que exista el contexto de React, así que
 * todo vive en este object y el módulo Expo sólo delega.
 *
 * Contrato con JS (una única línea de escritura por registro):
 *   mono()                  → SystemClock.elapsedRealtime()
 *   append(line)            → antepone {"seq":n, a la línea de record.ts
 *   setPhase(phase)         → fase visible para los hb
 *   setVerdict(outcome,json)→ verdict.json, dueño único (O_CREAT|O_EXCL)
 *   takePendingRequest()    → {runId, scenario} una sola vez, después null
 *   hardKill()              → Process.killProcess(myPid), sin handler
 *
 * Serialización: JS produce la línea completa MENOS `seq` (record.ts, A3);
 * acá sólo se hace el splice, o se serializan a mano los registros 100%
 * nativos (native_init, clock, uncaught, nojs_forced, hb) con las mismas 8
 * claves en el mismo orden: seq,t,mono,src,lvl,ev,phase,data.
 * La fase "sin valor" es "-" (convención compartida con record.ts).
 *
 * Escritura: append-only. Todo archivo se abre en modo agregado o con
 * O_CREAT|O_EXCL (primero gana); no existe ninguna apertura que descarte el
 * contenido previo (S8). Los descriptores se abren una vez por corrida y no
 * se cierran entre registros: la corrida termina con el proceso.
 */
object VioletaCore {

  private const val TAG = "violeta"
  private const val HB_MS = 1000L

  /** Convención "sin valor" compartida con record.ts (SIN_FASE). */
  private const val SIN_FASE = "-"

  private val lock = ReentrantLock()
  private val bound = AtomicBoolean(false)
  private val pending = AtomicReference<Pedido?>(null)

  @Volatile private var runId: String = ""
  @Volatile private var scenario: String = ""
  @Volatile private var jsPhase: String = SIN_FASE
  @Volatile private var jsSeq: Long? = null

  private var seq: Long = 0L // sólo bajo lock
  private var beat: Long = 0L // dueño: hilo de heartbeat

  @Volatile private var logOut: FileOutputStream? = null
  @Volatile private var hbOut: FileOutputStream? = null
  @Volatile private var runDir: File? = null
  private var previousHandler: Thread.UncaughtExceptionHandler? = null

  /** El handler que instalamos nosotros; evita re-instalar sobre el propio. */
  @Volatile private var ourHandler: Thread.UncaughtExceptionHandler? = null

  private class Pedido(val runId: String, val scenario: String)

  fun mono(): Double = SystemClock.elapsedRealtime().toDouble()

  fun setPhase(phase: String) {
    jsPhase = phase
  }

  /** A13: el escenario pedido por el host, para el corto-circuito en MainActivity. */
  fun isNoJsForced(): Boolean = scenario == "selftest.nojs"

  /**
   * A1/A2: liga la corrida al proceso. Idempotente: la segunda llamada es
   * no-op (recreación de la activity o `am start` sobre proceso vivo), así
   * que un proceso sólo escribe un `native_init`. Sin extra violeta.runId
   * (arranque manual) la corrida es `orphan-yyyyMMdd-HHmmss-SSS`.
   */
  fun beginRun(appContext: Context, extraRunId: String?, extraScenario: String?) {
    if (!bound.compareAndSet(false, true)) return
    val rid = extraRunId?.takeIf { it.isNotBlank() } ?: orphanRunId()
    val sc = extraScenario ?: ""
    runId = rid
    scenario = sc
    pending.set(Pedido(rid, sc))

    val dir = File(appContext.filesDir, "runs").resolve(rid)
    dir.mkdirs()
    runDir = dir
    writeExcl(
      File(dir, "request.json"),
      "{\"runId\":${jsonStr(rid)},\"scenario\":${jsonStr(sc)},\"t\":${System.currentTimeMillis()}}",
    )
    logOut = FileOutputStream(File(dir, "log.ndjson"), true)
    hbOut = FileOutputStream(File(dir, "heartbeat.ndjson"), true)

    emitToLog(
      "native_init",
      "info",
      "{\"runId\":${jsonStr(rid)},\"scenario\":${jsonStr(sc)},\"pid\":${Process.myPid()}}",
    )
    emitToLog("clock", "info", "{\"t\":${System.currentTimeMillis()}}")
    // A13: el escenario `selftest.nojs` marca el caso "runner ausente" desde
    // el lado nativo; el JS no emite nada para él (ver runner.ts).
    if (sc == "selftest.nojs") emitToLog("nojs_forced", "info", "{}")
    startHeartbeat()
    installUncaughtHandler()
  }

  /** A13: tercer registro nativo del corto-circuito, lo emite MainActivity. */
  fun emitNoJsForced() {
    emitToLog("nojs_forced", "info", "{}")
  }

  fun append(line: String): Long = lock.withLock {
    require(line.startsWith("{")) {
      "VioletaObs.append espera la línea del serializador de record.ts, que empieza por '{'"
    }
    val n = ++seq
    val completa = "{\"seq\":$n," + line.substring(1)
    val out = logOut
    if (out == null) {
      Log.w(TAG, "$runId append sin writer: $completa")
    } else {
      escribir(out, completa)
    }
    jsSeq = n
    n
  }

  fun takePendingRequest(): Map<String, String>? {
    val pedido = pending.getAndSet(null) ?: return null
    return mapOf("runId" to pedido.runId, "scenario" to pedido.scenario)
  }

  /** A11 (selftest.kill): muerte inmediata, sin pasar por el handler. */
  fun hardKill() {
    Process.killProcess(Process.myPid())
  }

  /**
   * A12: dueño único de verdict.json. O_CREAT|O_EXCL: si ya existe (la
   * corrida ya resolvió su final), la llamada es no-op silencioso.
   */
  fun writeVerdict(outcome: String, dataJson: String) {
    val dir = runDir ?: return
    val data = when {
      dataJson.isBlank() -> "{}"
      dataJson.trimStart().startsWith("{") -> dataJson
      else -> "{\"raw\":${jsonStr(dataJson)}}"
    }
    val n = lock.withLock { seq }
    writeExcl(
      File(dir, "verdict.json"),
      "{\"outcome\":${jsonStr(outcome)},\"t\":${System.currentTimeMillis()},\"seq\":$n,\"data\":$data}",
    )
  }

  // -- internos ---------------------------------------------------------------

  private fun orphanRunId(): String =
    "orphan-" + SimpleDateFormat("yyyyMMdd-HHmmss-SSS", Locale.US).format(Date())

  /** Escritura append + fsync por registro + espejo a logcat (A4). */
  private fun escribir(out: FileOutputStream, linea: String) {
    out.write((linea + "\n").toByteArray(Charsets.UTF_8))
    out.fd.sync()
    Log.i(TAG, "$runId $linea")
  }

  private fun emitToLog(ev: String, lvl: String, dataJson: String) {
    lock.withLock {
      val n = ++seq
      val out = logOut
      if (out == null) {
        Log.w(TAG, "$runId $ev sin writer")
      } else {
        escribir(out, lineaNat(n, ev, lvl, dataJson))
      }
    }
  }

  /** Llamable sólo bajo `lock`: lee `seq` y `jsPhase`. */
  private fun lineaNat(n: Long, ev: String, lvl: String, dataJson: String): String =
    "{\"seq\":$n,\"t\":${System.currentTimeMillis()},\"mono\":${SystemClock.elapsedRealtime()}" +
      ",\"src\":\"native\",\"lvl\":\"$lvl\",\"ev\":\"$ev\",\"phase\":${jsonStr(jsPhase)}" +
      ",\"data\":$dataJson}"

  /** A6: hilo daemon, 1000 ms, `beat` desde 0 y de 1 en 1. */
  private fun startHeartbeat() {
    val hilo = Thread {
      while (true) {
        try {
          Thread.sleep(HB_MS)
        } catch (e: InterruptedException) {
          return@Thread
        }
        try {
          emitHeartbeat()
        } catch (e: Throwable) {
          Log.w(TAG, "heartbeat fallo: $e")
        }
      }
    }
    hilo.name = "violeta-heartbeat"
    hilo.isDaemon = true
    hilo.start()
  }

  private fun emitHeartbeat() {
    lock.withLock {
      val n = ++seq
      val b = beat
      beat += 1
      val out = hbOut
      if (out != null) {
        val linea =
          "{\"seq\":$n,\"t\":${System.currentTimeMillis()},\"mono\":${SystemClock.elapsedRealtime()}" +
            ",\"src\":\"native\",\"lvl\":\"info\",\"ev\":\"hb\",\"phase\":${jsonStr(jsPhase)}" +
            // A6/A10: los cuatro campos van ADENTRO de data; jsSeq es
            // número o null, nunca el string "-".
            ",\"data\":{\"beat\":$b,\"pid\":${Process.myPid()}" +
            ",\"jsPhase\":${jsonStr(jsPhase)},\"jsSeq\":${jsSeq ?: "null"}}}"
        escribir(out, linea)
      }
    }
  }

  /**
   * S7: `uncaught` con data.stack, luego verdict crash, luego delegación.
   *
   * Re-instalable a propósito: React/Expo puede reemplazar el handler por
   * defecto después de `beginRun`, por eso MainActivity vuelve a instalarlo
   * tras `super.onCreate`. Cada instalación guarda el handler previo EN ESE
   * MOMENTO para delegar; si el default ya es el nuestro, es no-op (así
   * `previousHandler` nunca pasa a ser nuestro propio handler).
   */
  fun installUncaughtHandler() {
    val actual = Thread.getDefaultUncaughtExceptionHandler()
    if (actual === ourHandler) return
    previousHandler = actual
    val handler = Thread.UncaughtExceptionHandler { hilo, error ->
      try {
        val nombre = error.javaClass.name
        val mensaje = error.message ?: ""
        val stack = Log.getStackTraceString(error)
        val data =
          "{\"name\":${jsonStr(nombre)},\"message\":${jsonStr(mensaje)},\"stack\":${jsonStr(stack)}}"
        emitToLog("uncaught", "error", data)
        writeVerdict("crash", data)
      } catch (fallo: Throwable) {
        Log.w(TAG, "registro de uncaught fallo: $fallo")
      }
      previousHandler?.uncaughtException(hilo, error)
    }
    ourHandler = handler
    Thread.setDefaultUncaughtExceptionHandler(handler)
  }

  /**
   * Única apertura con O_CREAT|O_EXCL + fsync; modo 420 (0644). Si el
   * archivo ya existe, no-op: nunca se pisa evidencia previa.
   */
  private fun writeExcl(file: File, contenido: String) {
    val fd = try {
      Os.open(file.absolutePath, OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL, 420)
    } catch (e: ErrnoException) {
      if (e.errno == OsConstants.EEXIST) return else throw e
    }
    try {
      val bytes = (contenido + "\n").toByteArray(Charsets.UTF_8)
      var offset = 0
      while (offset < bytes.size) {
        offset += Os.write(fd, bytes, offset, bytes.size - offset)
      }
      Os.fsync(fd)
    } finally {
      Os.close(fd)
    }
  }

  private fun jsonStr(s: String): String {
    val sb = StringBuilder("\"")
    for (c in s) {
      when (c) {
        '"' -> sb.append("\\\"")
        '\\' -> sb.append("\\\\")
        '\n' -> sb.append("\\n")
        '\r' -> sb.append("\\r")
        '\t' -> sb.append("\\t")
        '\b' -> sb.append("\\b")
        '\u000C' -> sb.append("\\f")
        else ->
          if (c < ' ') {
            sb.append("\\u").append(c.code.toString(16).padStart(4, '0'))
          } else {
            sb.append(c)
          }
      }
    }
    sb.append('"')
    return sb.toString()
  }
}
