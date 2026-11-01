// Composition root de Violeta (A5/A12).
//
// Es el ÚNICO lugar que importa piezas atadas al dispositivo: `expo/fetch`, el
// almacén seguro y el adaptador de pi-ai. El resto del código las recibe por
// parámetro, y por eso las suites de host corren en Node sin React Native.
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { fetch as expoFetch } from "expo/fetch";
import * as SecureStore from "expo-secure-store";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";

import { installGlobalErrorHandler, defaultDeps, runHeadlessOnce } from "./src/harness/runner";
import { relojDelSistema } from "./src/harness/scenarios-nan";
import { isNativeAvailable } from "./src/harness/obs";
import { crearSecureStoreKey } from "./src/nan/key";
import { errInfo } from "./src/harness/record";
import type { StreamPiAi } from "./src/nan/cliente";
import { Chat } from "./src/app/chat";

/** Adaptador de pi-ai con la forma del stream del arnés (A5). */
const streamPiAi: StreamPiAi = (model, mensajes, opciones) =>
  streamSimple(
    model as Parameters<typeof streamSimple>[0],
    // pi-ai normaliza `systemPrompt`/`tools` a un transcript antes del request;
    // el arnés ya manda los mensajes en ese formato.
    mensajes as Parameters<typeof streamSimple>[1],
    opciones as Parameters<typeof streamSimple>[2],
  ) as unknown as AsyncIterable<never>;

const almacenKey = crearSecureStoreKey(SecureStore);

/** Dependencias reales del arnés: las de host, con las tres piezas del motor. */
export function depsDelDispositivo() {
  const base = defaultDeps();
  return {
    ...base,
    nan: {
      fetchImpl: expoFetch as unknown as typeof base.nan.fetchImpl,
      almacenKey,
      streamPiAi,
      reloj: relojDelSistema(),
    },
  };
}

export default function App() {
  const [pantalla, setPantalla] = useState<"home" | "chat">("home");

  useEffect(() => {
    // Requisito 6: un Error de JS fuera del dispatcher no llega al handler
    // nativo — RN lo intercepta con ErrorUtils. Este handler escribe
    // js_error + veredicto crash antes de delegar.
    installGlobalErrorHandler();
    // Arnés headless: sin request pendiente es un no-op.
    void runHeadlessOnce(depsDelDispositivo()).catch((err: unknown) => {
      try {
        depsDelDispositivo().obs.setVerdict("crash", JSON.stringify(errInfo(err)));
      } catch {
        // sin módulo nativo tampoco acá
      }
    });
  }, []);

  if (pantalla === "chat") {
    return (
      <View style={styles.pantalla}>
        <Chat
          fetchImpl={depsDelDispositivo().nan.fetchImpl}
          almacen={almacenKey}
          streamPiAi={streamPiAi}
          reloj={relojDelSistema()}
        />
        <Pressable style={styles.volver} onPress={() => setPantalla("home")}>
          <Text style={styles.volverTexto}>Volver</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Violeta</Text>
      <Text style={styles.estado}>
        {isNativeAvailable() ? "arnés listo" : "arnés sin módulo nativo"}
      </Text>
      <Pressable style={styles.boton} onPress={() => setPantalla("chat")}>
        <Text style={styles.botonTexto}>Abrir chat</Text>
      </Pressable>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  pantalla: { flex: 1 },
  container: {
    flex: 1,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  title: { fontSize: 28, fontWeight: "600" },
  estado: { fontSize: 13, opacity: 0.6 },
  boton: {
    backgroundColor: "#3a3a3a",
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  botonTexto: { color: "#fff", fontWeight: "600" },
  volver: { padding: 12, alignItems: "center" },
  volverTexto: { opacity: 0.7 },
});
