import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';
import { installGlobalErrorHandler, runHeadlessOnce } from './src/harness/runner';
import { VioletaObs, isNativeAvailable } from './src/harness/obs';
import { errInfo } from './src/harness/record';

export default function App() {
  useEffect(() => {
    // Diagnóstico del arnés: sin módulo nativo no hay artefactos posibles.
    // Sale por logcat (tag ReactNativeJS) porque el archivo aún no existe.
    console.log(`[violeta] native_available=${isNativeAvailable()} error_utils=${typeof (globalThis as { ErrorUtils?: unknown }).ErrorUtils}`);
    // Requisito 6: un Error de JS fuera del dispatcher (render, promesa
    // rechazada) no llega al handler nativo — RN lo intercepta con ErrorUtils.
    // Este handler escribe js_error + veredicto crash antes de delegar.
    installGlobalErrorHandler();
    // Arnés headless (T5): toma el request pendiente del módulo nativo y corre
    // el escenario. Sin request (arranque manual desde el launcher) es un no-op.
    // Review punto 6: el .catch es el último intento de artefacto — si el
    // runner murió sin poder dejar veredicto, intenta setVerdict("crash", ...)
    // una sola vez por el módulo nativo.
    void runHeadlessOnce().catch((err: unknown) => {
      try {
        VioletaObs.setVerdict('crash', JSON.stringify(errInfo(err)));
      } catch {
        // Sin módulo nativo tampoco acá: no hay a quién emitir.
      }
    });
  }, []);
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Violeta</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: 28, fontWeight: '600' },
});
