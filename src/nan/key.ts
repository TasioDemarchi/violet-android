export const NAN_FALTA_KEY = "nan: falta la key en el dispositivo";
export const ITEM_KEY = "violeta.nan.apiKey";

export interface AlmacenKey {
  leer(): Promise<string | null>;
  guardar(valor: string): Promise<void>;
  borrar(): Promise<void>;
}

/** Puerto del almacenamiento seguro: se inyecta para no importar Expo en Node. */
export interface AlmacenSeguro {
  getItemAsync(clave: string): Promise<string | null>;
  setItemAsync(clave: string, valor: string): Promise<void>;
  deleteItemAsync(clave: string): Promise<void>;
}

export function crearSecureStoreKey(almacen: AlmacenSeguro): AlmacenKey {
  return {
    async leer() {
      return await almacen.getItemAsync(ITEM_KEY);
    },
    async guardar(valor: string) {
      await almacen.setItemAsync(ITEM_KEY, valor);
    },
    async borrar() {
      await almacen.deleteItemAsync(ITEM_KEY);
    },
  };
}

export function crearMemoriaKey(inicial?: string | null): AlmacenKey {
  let valor: string | null = inicial ?? null;
  return {
    async leer() {
      return valor;
    },
    async guardar(nuevo: string) {
      valor = nuevo;
    },
    async borrar() {
      valor = null;
    },
  };
}

/** Lee la key y, si no hay, lanza un Error con message exactamente NAN_FALTA_KEY. */
export async function leerKeyObligatoria(almacen: AlmacenKey): Promise<string> {
  const valor = await almacen.leer();
  const recortada = valor?.trim();
  if (!recortada) {
    throw new Error(NAN_FALTA_KEY);
  }
  return recortada;
}
