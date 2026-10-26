import { test } from '@playwright/test';

// Recorrido previsto contra un MEJ-2 aislado ya reservado: login, organización, cajas,
// saldo inicial sin código, prestatario, términos sin código, operación protegida,
// reuso de la hora, cierre y recarga. No se ejecuta sin MEJ3_BASE_URL de una corrida propia.
test.skip(!process.env.MEJ3_BASE_URL, 'Sin base aislada reservada para MEJ-3. No se usa 27017 ni 27181.');

test('recorrido sintético MEJ-3', async () => {
  test.fixme(true, 'La base aislada no quedó levantada en esta entrega.');
});
