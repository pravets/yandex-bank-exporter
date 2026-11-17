// Галочка «переводы между счетами» не должна убирать обычные переводы.
import assert from 'node:assert/strict';

import { loadPopup } from './load-popup.mjs';
import { rawItem } from './raw-fixtures.mjs';

loadPopup();
const g = globalThis;

const purchase = g.mapItem(
  rawItem({ id: 'purchase', description: 'Супермаркеты', amount: { money: { amount: '3.00', currency: 'RUB' } } }),
);
const transferOut = g.mapItem(
  rawItem({
    id: 'transfer-out',
    description: 'Перевод',
    direction: 'DEBIT',
    title: { plain: 'Иосиф П.' },
    amount: { money: { amount: '100.00', currency: 'RUB' } },
  }),
);
const transferIn = g.mapItem(
  rawItem({
    id: 'transfer-in',
    description: 'Перевод',
    direction: 'CREDIT',
    title: { plain: 'Иосиф П.' },
    amount: { money: { amount: '25.00', currency: 'RUB' } },
  }),
);
const internal = g.mapItem(
  rawItem({
    id: 'internal',
    description: 'Перевод между счетами',
    direction: 'DEBIT',
    title: { plain: 'Перевод на накопительный' },
    amount: { money: { amount: '40000.00', currency: 'RUB' } },
  }),
);

const all = [purchase, transferOut, transferIn, internal];

// --- типы различаются ---
assert.equal(g.isInternalTransfer(internal), true);
assert.equal(g.isInternalTransfer(transferOut), false);
assert.equal(g.isInternalTransfer(transferIn), false);
assert.equal(g.isInternalTransfer(purchase), false);

// --- выключенная галочка оставляет покупку и оба обычных перевода ---
const withoutInternal = all.filter((row) => g.shouldIncludeRow(row, false));
assert.deepEqual(
  withoutInternal.map((row) => row.rawId),
  ['purchase', 'transfer-out', 'transfer-in'],
  'исключается только внутренний перевод',
);

// --- включённая галочка оставляет всё ---
assert.equal(all.filter((row) => g.shouldIncludeRow(row, true)).length, 4);

// --- агрегация переводов по-прежнему включает оба типа ---
assert.equal(internal.kind, 'Перевод между счетами');
assert.equal(transferOut.kind, 'Перевод');
assert.equal(g.isInternalTransfer({ kind: 'Перевод' }), false);

console.log('transfers: OK');
