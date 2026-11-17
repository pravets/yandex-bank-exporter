// Контракт периода: все границы считаются по МСК и не зависят от локальной зоны.
// Запускается с TZ из матрицы в run-tests.mjs; зону принимает аргументом только
// ради читаемых сообщений.
import assert from 'node:assert/strict';

import { loadPopup } from './load-popup.mjs';

const zone = process.argv[2] || process.env.TZ || 'local';

const elements = {
  period: { value: 'current' },
  dateFrom: { value: '' },
  dateTo: { value: '' },
};

loadPopup({ getElementById: (id) => elements[id] || null });

const g = globalThis;
const iso = (ms) => new Date(ms).toISOString();

// Синтетический момент: в МСК уже 1 января 2026, в UTC ещё 31 декабря 2025.
const newYear = new Date('2025-12-31T22:30:00.000Z');

// --- текущий и прошлый год определяются по МСК ---
elements.period.value = 'current';
let period = g.getPeriod(newYear);
assert.equal(period.label, '2026', `${zone}: текущий год должен быть 2026`);
assert.equal(iso(period.from.getTime()), '2025-12-31T21:00:00.000Z', `${zone}: начало 2026 по МСК`);
assert.equal(period.toExclusive, null, `${zone}: у текущего года нет верхней границы`);
assert.equal(period.invalidReason, null);

elements.period.value = 'prev';
period = g.getPeriod(newYear);
assert.equal(period.label, '2025', `${zone}: прошлый год должен быть 2025`);
assert.equal(iso(period.from.getTime()), '2024-12-31T21:00:00.000Z', `${zone}: начало 2025 по МСК`);
assert.equal(iso(period.toExclusive.getTime()), '2025-12-31T21:00:00.000Z', `${zone}: конец 2025 по МСК`);

// --- начальные значения полей дат ---
assert.deepEqual(g.defaultDateRange(newYear), { from: '2026-01-01', to: '2026-01-01' }, `${zone}: начало года по МСК`);
assert.deepEqual(
  g.defaultDateRange(new Date('2026-03-10T10:00:00.000Z')),
  { from: '2026-01-01', to: '2026-03-10' },
  `${zone}: текущий день по МСК`,
);

// --- свой период: целые московские дни, [from, toExclusive) ---
elements.period.value = 'custom';
elements.dateFrom.value = '2026-01-01';
elements.dateTo.value = '2026-01-01';
period = g.getPeriod(newYear);
assert.equal(period.label, '2026-01-01_2026-01-01', `${zone}: label без UTC-сдвига`);
assert.equal(iso(period.from.getTime()), '2025-12-31T21:00:00.000Z', `${zone}: начало дня по МСК`);
assert.equal(iso(period.toExclusive.getTime()), '2026-01-01T21:00:00.000Z', `${zone}: конец дня исключительный`);
assert.equal(period.invalidReason, null);

const inDay = (text) => g.inPeriod({ time: Date.parse(text) }, period);
assert.equal(inDay('2025-12-31T20:59:59.999Z'), false, `${zone}: за миг до начала`);
assert.equal(inDay('2025-12-31T21:00:00.000Z'), true, `${zone}: первая миллисекунда дня`);
assert.equal(inDay('2026-01-01T20:59:59.999Z'), true, `${zone}: последняя миллисекунда дня`);
assert.equal(inDay('2026-01-01T21:00:00.000Z'), false, `${zone}: начало следующего дня`);
assert.equal(g.inPeriod({ time: NaN }, period), false, `${zone}: строка без даты при границах отбрасывается`);

// --- обратный диапазон и мусор в датах ---
elements.dateFrom.value = '2026-02-01';
elements.dateTo.value = '2026-01-01';
period = g.getPeriod(newYear);
assert.ok(period.invalidReason, `${zone}: обратный диапазон должен быть ошибкой`);

elements.dateFrom.value = '2026-02-30';
elements.dateTo.value = '';
period = g.getPeriod(newYear);
assert.ok(period.invalidReason, `${zone}: несуществующая дата должна быть ошибкой`);

// --- открытые границы ---
elements.dateFrom.value = '';
elements.dateTo.value = '2026-01-01';
period = g.getPeriod(newYear);
assert.equal(period.from, null);
assert.equal(iso(period.toExclusive.getTime()), '2026-01-01T21:00:00.000Z');
assert.equal(g.inPeriod({ time: Date.parse('2020-01-01T00:00:00.000Z') }, period), true);

elements.dateFrom.value = '';
elements.dateTo.value = '';
period = g.getPeriod(newYear);
assert.equal(period.from, null);
assert.equal(period.toExclusive, null);
assert.equal(period.label, 'начало_сегодня');
assert.equal(g.inPeriod({ time: Date.parse('2020-01-01T00:00:00.000Z') }, period), true);

// --- «всё время» ---
elements.period.value = 'all';
period = g.getPeriod(newYear);
assert.equal(period.label, 'всё время');
assert.equal(period.from, null);
assert.equal(period.toExclusive, null);

// --- имена файлов ---
const names = {
  'всё время': 'Яндекс_Пэй_всё_время.xlsx',
  '2026': 'Яндекс_Пэй_2026.xlsx',
  '2025': 'Яндекс_Пэй_2025.xlsx',
  '2026-01-01_2026-01-01': 'Яндекс_Пэй_2026-01-01_2026-01-01.xlsx',
  начало_сегодня: 'Яндекс_Пэй_начало_сегодня.xlsx',
};
for (const [label, expected] of Object.entries(names)) {
  assert.equal(g.buildReportFilename(label), expected, `${zone}: имя для «${label}»`);
}

const risky = g.buildReportFilename('a/b:c*d?e"f<g>h|i\\j   ');
assert.ok(!/[/\\:*?"<>|]/.test(risky), `${zone}: запрещённые символы в имени: ${risky}`);
assert.ok(risky.startsWith('Яндекс_Пэй_') && risky.endsWith('.xlsx'), `${zone}: рамка имени`);
assert.ok(!/^Яндекс_Пэй_.*__\.xlsx$/.test(risky), `${zone}: лишние подчёркивания: ${risky}`);

assert.equal(g.buildReportFilename('   '), 'Яндекс_Пэй_период.xlsx', `${zone}: пустой лейбл`);

const long = g.buildReportFilename('я'.repeat(200));
assert.ok(long.length <= 'Яндекс_Пэй_'.length + 80 + '.xlsx'.length, `${zone}: длина имени ${long.length}`);

console.log(`period-contract ok (${zone})`);
