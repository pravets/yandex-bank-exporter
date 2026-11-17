// Контракт данных: битые суммы, валюта и дата не подменяются нулём,
// попадают в отчёт с явной причиной и не участвуют в KPI.
import assert from 'node:assert/strict';

import { loadPopup } from './load-popup.mjs';
import { rawItem } from './raw-fixtures.mjs';

loadPopup();
const g = globalThis;

// --- корректная операция ---
const good = g.mapItem(rawItem({ amount: { money: { amount: '10.50', currency: 'RUB' } } }));
assert.equal(good.amount, 10.5);
assert.equal(good.dataError, '');
assert.equal(good.currency, 'RUB');
assert.ok(Number.isFinite(good.time));

// --- нечисловая сумма ---
const badAmount = g.mapItem(
  rawItem({ id: 'bad-amount', amount: { money: { amount: 'invalid', currency: 'RUB' } } }),
);
assert.equal(badAmount.amount, null, 'сумма не должна становиться NaN');
assert.equal(badAmount.dataError, 'некорректная сумма');

// --- не-RUB валюта ---
const usd = g.mapItem(
  rawItem({ id: 'usd', amount: { money: { amount: '10.00', currency: 'USD' } } }),
);
assert.equal(usd.dataError, 'валюта USD');
assert.equal(usd.amount, 10, 'сумма сохраняется, но строка исключается из итогов');

// --- битая дата ---
const badDate = g.mapItem(rawItem({ id: 'bad-date', date: 'not-a-date' }));
assert.equal(badDate.dataError, 'некорректная дата');
assert.equal(badDate.monthKey, '');
assert.ok(Number.isNaN(badDate.time));
assert.equal(badDate.year, 0, 'календарные поля не берутся из локальной зоны');

// --- битые баллы и кешбэк ---
const badPoints = g.mapItem(
  rawItem({ id: 'bad-points', amount: { money: null, plus: 'abc' } }),
);
assert.equal(badPoints.points, null);
assert.equal(badPoints.dataError, 'некорректные баллы');
assert.equal(badPoints.kind, 'Баллы');

// --- сводка не считает строки с ошибкой данных и без даты ---
const rows = [good, badAmount, usd, badDate, badPoints];
const sheets = g.buildSheets(rows, { periodLabel: '2026', subtitle: '', skipped: '' });
const operations = sheets[0];
const summary = sheets[1];

// шапка содержит направление сразу после типа
assert.deepEqual(
  operations.rows[0].map((cell) => cell.v),
  [
    '№',
    'Дата',
    'Время',
    'Месяц',
    'Описание',
    'Категория',
    'Тип',
    'Направление',
    'Сумма, ₽',
    'Баллы',
    'Кешбэк, баллы',
    'Карта / счёт',
    'Статус',
    'ID операции',
  ],
);
assert.equal(operations.autoFilter, 'A1:N6');

// строка с ошибкой данных видна в статусе
const badRow = operations.rows.find(
  (cells) => cells[12] && cells[12].v === 'Некорректные данные: некорректная сумма',
);
assert.ok(badRow, 'битая строка должна остаться в листе со причиной');

// направление проставляется в колонке (ID-колонка содержит opId, а не rawId)
const goodLine = operations.rows.find((cells) => cells[12] && cells[12].v === 'Проведено');
assert.ok(goodLine, 'корректная строка на месте');
assert.equal(goodLine[7].v, 'Списание');

// KPI считает только корректную операцию: 10.50
const kpi = new Map();
for (const cells of summary.rows) {
  if (cells[0] && typeof cells[0].v === 'string' && cells[1] && typeof cells[1].v === 'number') {
    kpi.set(cells[0].v, cells[1].v);
  }
}
assert.equal(kpi.get('Расходы (покупки и услуги), ₽'), 10.5, 'битые строки не попадают в KPI');
assert.equal(kpi.get('Всего списаний, ₽'), 10.5);

// месяц с единственной корректной операцией остался, «нулевых» месяцев нет
const monthLabels = summary.rows
  .map((cells) => cells[3])
  .filter((cell) => cell && /^\S+ \d{4}$/.test(String(cell.v)))
  .map((cell) => cell.v);
assert.deepEqual(monthLabels, ['янв 2026']);

console.log('money: OK');
