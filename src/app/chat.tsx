// Pantalla de conversación mínima (T5, A12).
//
// Sin router: la monta `App.tsx` con un estado local. Todo lo pesado (fetch,
// almacén seguro, adaptador de pi-ai) entra por props desde el composition root,
// así este archivo no importa nada de Expo ni de pi-ai y puede typechequearse y
// testearse sin dispositivo.
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import type { AlmacenKey } from "../nan/key.ts";
import { NAN_FALTA_KEY } from "../nan/key.ts";
import { conversar, type Reloj } from "../nan/herramientas.ts";
import type { FetchInyectable, StreamPiAi } from "../nan/cliente.ts";
import { crearCliente } from "../nan/cliente.ts";

export interface ChatProps {
  fetchImpl: FetchInyectable;
  almacen: AlmacenKey;
  streamPiAi: StreamPiAi;
  reloj: Reloj;
}

/** Texto de pantalla cuando falta la key (S3; el literal del cliente es otro). */
export const TEXTO_FALTA_KEY = "Falta la key de NaN. Pegala y tocá Guardar.";
export const TEXTO_GUARDADA = "Key guardada.";
export const TEXTO_BORRADA = "Key borrada del dispositivo.";

export function Chat({ fetchImpl, almacen, streamPiAi, reloj }: ChatProps) {
  const [keyVisible, setKeyVisible] = useState("");
  const [aviso, setAviso] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState("");
  const [respuesta, setRespuesta] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const guardarKey = useCallback(async () => {
    try {
      if (keyVisible.trim().length === 0) {
        await almacen.borrar();
        setAviso(TEXTO_BORRADA);
        return;
      }
      await almacen.guardar(keyVisible.trim());
      setKeyVisible("");
      setAviso(TEXTO_GUARDADA);
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : String(fallo));
    }
  }, [almacen, keyVisible]);

  const borrarKey = useCallback(async () => {
    try {
      await almacen.borrar();
      setKeyVisible("");
      setAviso(TEXTO_BORRADA);
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : String(fallo));
    }
  }, [almacen]);

  const enviar = useCallback(async () => {
    const texto = mensaje.trim();
    if (texto.length === 0 || enviando) return;
    setEnviando(true);
    setError(null);
    setRespuesta("");
    const control = new AbortController();
    abortRef.current = control;
    try {
      const resultado = await conversar({
        cliente: crearCliente({ fetch: fetchImpl, almacen, stream: streamPiAi }),
        mensajes: [{ role: "user", content: texto }],
        reloj,
        signal: control.signal,
        onDelta: (delta) => setRespuesta((previo) => previo + delta),
      });
      // Si el modelo no emitió deltas (respuesta cacheada), se muestra el texto.
      setRespuesta((previo) => (previo.length > 0 ? previo : resultado.texto));
      setMensaje("");
    } catch (fallo) {
      const mensajeError = fallo instanceof Error ? fallo.message : String(fallo);
      setError(mensajeError === NAN_FALTA_KEY ? TEXTO_FALTA_KEY : mensajeError);
    } finally {
      abortRef.current = null;
      setEnviando(false);
    }
  }, [almacen, enviando, fetchImpl, mensaje, reloj, streamPiAi]);

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Violeta</Text>

      <View style={styles.bloque}>
        <Text style={styles.label}>API key de NaN</Text>
        <TextInput
          testID="key-input"
          style={styles.input}
          value={keyVisible}
          onChangeText={setKeyVisible}
          placeholder="Pegá la key y tocá Guardar"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.fila}>
          <Pressable testID="key-guardar" style={styles.boton} onPress={guardarKey}>
            <Text style={styles.botonTexto}>Guardar</Text>
          </Pressable>
          <Pressable testID="key-borrar" style={styles.botonSecundario} onPress={borrarKey}>
            <Text style={styles.botonTexto}>Borrar key</Text>
          </Pressable>
        </View>
        {aviso !== null && <Text testID="key-aviso" style={styles.aviso}>{aviso}</Text>}
      </View>

      <View style={styles.bloque}>
        <TextInput
          testID="mensaje-input"
          style={styles.input}
          value={mensaje}
          onChangeText={setMensaje}
          placeholder="Escribí un mensaje"
          multiline
        />
        <Pressable
          testID="enviar"
          style={[styles.boton, enviando && styles.botonApagado]}
          onPress={enviar}
          disabled={enviando}
        >
          <Text style={styles.botonTexto}>{enviando ? "Enviando…" : "Enviar"}</Text>
        </Pressable>
        {enviando && <ActivityIndicator />}
      </View>

      <ScrollView style={styles.respuesta} contentContainerStyle={styles.respuestaContenido}>
        <Text testID="respuesta">{respuesta}</Text>
        {error !== null && (
          <Text testID="error" style={styles.error}>
            {error}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16, gap: 12 },
  title: { fontSize: 24, fontWeight: "600" },
  bloque: { gap: 8 },
  fila: { flexDirection: "row", gap: 8 },
  label: { fontSize: 13, opacity: 0.7 },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
  boton: {
    backgroundColor: "#3a3a3a",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  botonSecundario: {
    borderWidth: 1,
    borderColor: "#bbb",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  botonApagado: { opacity: 0.5 },
  botonTexto: { color: "#fff", fontWeight: "600" },
  aviso: { fontSize: 13, opacity: 0.8 },
  respuesta: { flex: 1 },
  respuestaContenido: { gap: 8 },
  error: { color: "#b00020" },
});
