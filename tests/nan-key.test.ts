import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ITEM_KEY,
  NAN_FALTA_KEY,
  crearMemoriaKey,
  crearSecureStoreKey,
  leerKeyObligatoria,
  type AlmacenSeguro,
} from "../src/nan/key.ts";

function dobleAlmacenSeguro() {
  const items = new Map<string, string>();
  const llamadas: string[] = [];
  const almacen: AlmacenSeguro = {
    async getItemAsync(clave) {
      llamadas.push(`get:${clave}`);
      return items.get(clave) ?? null;
    },
    async setItemAsync(clave, valor) {
      llamadas.push(`set:${clave}`);
      items.set(clave, valor);
    },
    async deleteItemAsync(clave) {
      llamadas.push(`del:${clave}`);
      items.delete(clave);
    },
  };
  return { almacen, items, llamadas };
}

test("S3: NAN_FALTA_KEY es el literal exacto de falta de key", () => {
  assert.equal(NAN_FALTA_KEY, "nan: falta la key en el dispositivo");
});

test("S3: ITEM_KEY es violeta.nan.apiKey", () => {
  assert.equal(ITEM_KEY, "violeta.nan.apiKey");
});

test("S3: crearMemoriaKey guarda, lee y borra en memoria", async () => {
  const key = crearMemoriaKey();
  assert.equal(await key.leer(), null);
  await key.guardar("sk-memoria");
  assert.equal(await key.leer(), "sk-memoria");
  await key.borrar();
  assert.equal(await key.leer(), null);
});

test("S3: crearMemoriaKey acepta un valor inicial", async () => {
  const key = crearMemoriaKey("key-sentinela-no-real");
  assert.equal(await key.leer(), "key-sentinela-no-real");
});

test("S3: SecureStoreKey usa ITEM_KEY como única clave del almacén", async () => {
  const { almacen, items, llamadas } = dobleAlmacenSeguro();
  const key = crearSecureStoreKey(almacen);

  await key.guardar("sk-dispositivo");
  assert.equal(await key.leer(), "sk-dispositivo");
  assert.deepEqual([...items.keys()], [ITEM_KEY]);
  assert.ok(llamadas.includes(`set:${ITEM_KEY}`));
  assert.ok(llamadas.includes(`get:${ITEM_KEY}`));

  await key.borrar();
  assert.equal(await key.leer(), null);
  assert.ok(llamadas.includes(`del:${ITEM_KEY}`));
  assert.equal(items.size, 0);
});

test("S3: leerKeyObligatoria devuelve la key cuando existe", async () => {
  const key = crearMemoriaKey("sk-valida");
  assert.equal(await leerKeyObligatoria(key), "sk-valida");
});

test("S3: leerKeyObligatoria lanza exactamente NAN_FALTA_KEY cuando falta", async () => {
  const key = crearMemoriaKey();
  await assert.rejects(leerKeyObligatoria(key), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.equal(e.message, NAN_FALTA_KEY);
    assert.equal(e.message, "nan: falta la key en el dispositivo");
    return true;
  });
});

test("S3: valor vacío o sólo espacios cuenta como falta de key", async () => {
  for (const vacia of ["", "   ", "\t\n "]) {
    const key = crearMemoriaKey(vacia);
    await assert.rejects(leerKeyObligatoria(key), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal(e.message, NAN_FALTA_KEY);
      return true;
    });
  }
});

test("S3: una key con espacios en los bordes se recorta con trim(), nada más", async () => {
  const key = crearMemoriaKey("  sk-con-bordes  ");
  assert.equal(await leerKeyObligatoria(key), "sk-con-bordes");
});

test("S3: borrar dos veces no falla y deja leer() en null (idempotente)", async () => {
  const key = crearMemoriaKey("sk-a-borrar");
  await key.borrar();
  await key.borrar();
  assert.equal(await key.leer(), null);

  const { almacen } = dobleAlmacenSeguro();
  const segura = crearSecureStoreKey(almacen);
  await segura.guardar("sk-a-borrar");
  await segura.borrar();
  await segura.borrar();
  assert.equal(await segura.leer(), null);
});
