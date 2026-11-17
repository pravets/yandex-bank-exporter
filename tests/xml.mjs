// Деньги и XML: округление half-up по копейкам и удаление недопустимых символов.
import assert from 'node:assert/strict';

import { loadPopup } from './load-popup.mjs';

loadPopup();
const g = globalThis;

// --- округление денег ---
assert.equal(g.round2(10.075), 10.08, 'half-up, а не двоичное усечение');
assert.equal(g.round2(-10.075), -10.08, 'знак сохраняется');
assert.equal(g.round2(1.005), 1.01);
assert.equal(g.round2(2.675), 2.68);
assert.equal(g.round2(0.1 + 0.2), 0.3);
assert.equal(g.round2(0), 0);
assert.ok(Number.isNaN(g.round2(NaN)));

// --- недопустимые символы XML не попадают в файл ---
const dirty = 'магазин\u0001 \uFFFE \uFFFF \uFDD0 \uD800 =1+1 & <m>';
const sheets = [
  {
    name: 'Операции',
    rows: [
      [{ v: 'Описание' }],
      [{ v: dirty }],
    ],
  },
];
const bytes = g.XlsxLite.build(sheets);
const text = new TextDecoder('utf-8').decode(bytes);
// Проверяем только XML листа: в ZIP-заголовках встречаются произвольные байты.
const sheetMatch = /<worksheet[\s\S]*?<\/worksheet>/.exec(text);
assert.ok(sheetMatch, 'XML листа найден');
const sheetXml = sheetMatch[0];

assert.equal(sheetXml.includes('\uFFFE'), false, 'U+FFFE вырезан');
assert.equal(sheetXml.includes('\uFFFF'), false, 'U+FFFF вырезан');
assert.equal(sheetXml.includes('\uFDD0'), false, 'noncharacter U+FDD0 вырезан');
assert.equal(sheetXml.includes('\u0001'), false, 'C0 вырезан');
assert.equal(sheetXml.includes('\uD800'), false, 'одиночный суррогат вырезан');

// Формулоподобный текст остаётся текстом, а не формулой.
assert.ok(sheetXml.includes('=1+1'), 'текст «=1+1» сохранён');
assert.ok(sheetXml.includes('&amp;'), 'амперсанд экранирован');
assert.ok(sheetXml.includes('&lt;m&gt;'), 'угловые скобки экранированы');

console.log('xml: OK');
