package dev.tasio.violeta

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper
import expo.modules.violetaobs.VioletaCore

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // A1: los extras se leen sólo acá, antes de crear el root view de React.
    // No hay onNewIntent: el driver hace am force-stop antes de cada corrida,
    // así que cada corrida arranca con un proceso nuevo y su propio onCreate.
    VioletaCore.beginRun(
      applicationContext,
      intent.getStringExtra("violeta.runId"),
      intent.getStringExtra("violeta.scenario"),
    )

    // A13: `selftest.nojs` NO se corta acá — saltarse `super.onCreate()` en
    // una Activity lanza SuperNotCalledException (verificado en dispositivo:
    // el driver lo veía como `crash`). El registro `nojs_forced` lo emite
    // `beginRun` y el runner de JS se calla para ese escenario, que es lo que
    // produce "native_init sin js_boot" (ver runner.ts).

    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    setTheme(R.style.AppTheme);
    super.onCreate(null)

    // Review punto 5: React/Expo puede reemplazar el handler por defecto de
    // excepción no atrapada durante el arranque. Re-instalamos el nuestro lo
    // más tarde posible, guardando el handler vigente en ese momento para
    // delegar (installUncaughtHandler es no-op si el default ya es el nuestro).
    VioletaCore.installUncaughtHandler()
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }
}
