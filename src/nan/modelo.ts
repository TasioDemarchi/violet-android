// A4: literal del modelo NaN. El tipo NO se importa del barrel de pi-ai (S1):
// se deriva de `streamSimple` del adaptador `api/openai-completions` con un
// import type-only, que en runtime se borra y no carga ningún SDK.
import type { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";

/** `Model<"openai-completions">`, derivado del primer parámetro de `streamSimple`. */
export type Modelo = Parameters<typeof streamSimple>[0];

export const MODELO_NAN: Modelo = {
  id: "deepseek-v4-flash",
  name: "deepseek-v4-flash",
  api: "openai-completions",
  provider: "nan",
  baseUrl: "https://api.nan.builders/v1",
  input: ["text"],
  maxTokens: 16384,
  contextWindow: 1000000,
  compat: { maxTokensField: "max_tokens" },
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
