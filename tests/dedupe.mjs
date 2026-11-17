// Дедупликация: записи без ID, различающиеся категорией или статусом, не теряются.
import assert from 'node:assert/strict';

import { loadPopup } from './load-popup.mjs';
import { rawItem } from './raw-fixtures.mjs';

loadPopup();
const g = globalThis;

const base = { id: '', date: '2026-01-10T12:00:00.000Z', direction: 'DEBIT' };

const market = g.mapItem(rawItem({ ...base, description: 'Супермаркеты' }));
const pharmacy = g.mapItem(rawItem({ ...base, description: 'Аптеки' }));

// Разные категории при прочих равных — разные операции.
assert.notEqual(market.matchKey, pharmacy.matchKey);
assert.notEqual(market.contentKey, pharmacy.contentKey);

// Полные дубликаты (тот же вход) склеиваются.
const marketAgain = g.mapItem(rawItem({ ...base, description: 'Супермаркеты' }));
assert.equal(market.matchKey, marketAgain.matchKey);

// Разный статус — тоже разные записи.
const cleared = g.mapItem(rawItem({ ...base, description: 'Супермаркеты', statusCode: 'CLEAR' }));
const cancelled = g.mapItem(
  rawItem({ ...base, description: 'Супермаркеты', statusCode: 'CANCEL' }),
);
assert.notEqual(cleared.matchKey, cancelled.matchKey);

// ID по-прежнему главный ключ, даже если остальные поля совпали.
const withIdA = g.mapItem(rawItem({ ...base, id: 'A', description: 'Супермаркеты' }));
const withIdB = g.mapItem(rawItem({ ...base, id: 'B', description: 'Супермаркеты' }));
assert.equal(withIdA.matchKey, 'A');
assert.equal(withIdB.matchKey, 'B');
assert.notEqual(withIdA.matchKey, withIdB.matchKey);

// Без ID отпечаток различим, а не пустая строка.
assert.ok(market.matchKey.length > 0);
assert.equal(market.rawId, '');

console.log('dedupe: OK');
