// Пагинация collectPages без Chrome: подменяем globalThis.fetchPage.
// Проверяем причину остановки, полноту, дедупликацию, повтор курсора и лимит.
import assert from 'node:assert/strict';

import { loadPopup } from './load-popup.mjs';
import { rawItem } from './raw-fixtures.mjs';

loadPopup();
const g = globalThis;

const period = { from: new Date('2026-03-01T00:00:00.000Z'), toExclusive: null };
const template = '{}';

/** Ставит фейковый fetchPage с очередью ответов; возвращает журнал вызовов. */
function stubPages(responses) {
  const calls = [];
  g.fetchPage = async (_tabId, _template, cursor, filter) => {
    calls.push({ cursor, filter });
    const next = responses.shift();
    if (!next) throw new Error('лишний запрос страницы: ' + calls.length);
    return next;
  };
  return calls;
}

const dateItem = (id, date) => rawItem({ id, date });

// --- 1. остановка по дате: лента ушла за начало периода ---
{
  const calls = stubPages([
    { items: [dateItem('a', '2026-03-10T12:00:00.000Z'), dateItem('b', '2026-03-09T12:00:00.000Z')], cursor: 'c2' },
    { items: [dateItem('c', '2026-03-02T12:00:00.000Z')], cursor: 'c3' },
    { items: [dateItem('d', '2026-02-20T12:00:00.000Z')], cursor: 'c4' },
  ]);
  const result = await g.collectPages(1, template, period, null);
  assert.equal(result.stopReason, 'period');
  assert.equal(result.complete, true);
  assert.equal(result.pages, 3);
  assert.equal(result.requests, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(result.rows.map((row) => row.rawId), ['a', 'b', 'c', 'd']);
}

// --- 2. конец ленты без курсора ---
{
  stubPages([{ items: [dateItem('a', '2026-03-10T12:00:00.000Z')], cursor: null }]);
  const result = await g.collectPages(1, template, period, null);
  assert.equal(result.stopReason, 'end');
  assert.equal(result.complete, true);
  assert.equal(result.rows.length, 1);
}

// --- 3. пустая страница ---
{
  stubPages([{ items: [], cursor: 'c2' }]);
  const result = await g.collectPages(1, template, period, null);
  assert.equal(result.stopReason, 'empty');
  assert.equal(result.complete, true);
  assert.equal(result.rows.length, 0);
}

// --- 4. дедупликация страницы с дубликатом ---
{
  const dup = dateItem('dup', '2026-03-10T12:00:00.000Z');
  stubPages([{ items: [dup, dup], cursor: null }]);
  const result = await g.collectPages(1, template, period, null);
  assert.equal(result.rows.length, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.stopReason, 'end');
}

// --- 5. повтор курсора: одна уникальная строка вместо 400 запросов ---
{
  const calls = stubPages([
    { items: [dateItem('a', '2026-03-10T12:00:00.000Z')], cursor: 'repeat' },
    { items: [dateItem('b', '2026-03-09T12:00:00.000Z')], cursor: 'repeat' },
  ]);
  const result = await g.collectPages(1, template, period, null);
  assert.equal(result.stopReason, 'no-progress');
  assert.equal(result.complete, false);
  assert.equal(calls.length, 2, 'на повторе курсора останавливаемся сразу');
  assert.equal(result.rows.length, 2);
}

// --- 6. страница без новых строк тоже считается отсутствием прогресса ---
{
  const same = dateItem('a', '2026-03-10T12:00:00.000Z');
  const calls = stubPages([
    { items: [same], cursor: 'c2' },
    { items: [same], cursor: 'c3' },
  ]);
  const result = await g.collectPages(1, template, period, null);
  assert.equal(result.stopReason, 'no-progress');
  assert.equal(result.complete, false);
  assert.equal(calls.length, 2);
}

// --- 7. лимит страниц помечает результат неполным ---
{
  let page = 0;
  const calls = stubPages(
    Array.from({ length: 500 }, () => {
      page += 1;
      // У каждой страницы уникальный ID и новый непустой курсор: лента бесконечная.
      return {
        items: [rawItem({ id: 'op-' + page, date: '2026-03-10T12:00:00.000Z' })],
        cursor: 'c' + page,
      };
    }),
  );
  const result = await g.collectPages(1, template, period, null);
  assert.equal(calls.length, 400, 'останавливаемся на MAX_PAGES из popup.js');
  assert.equal(result.stopReason, 'limit');
  assert.equal(result.complete, false);
}

// --- 8. альтернативная форма фильтра пробуется только при ошибке ---
{
  const product = { filterType: 'PAY_CARD', agreementId: 'pa_X' };
  const calls = stubPages([
    { error: 'HTTP 400' },
    { items: [dateItem('wide', '2026-03-10T12:00:00.000Z')], cursor: null },
  ]);
  const result = await g.collectPages(1, template, period, product);
  assert.equal(result.complete, true);
  assert.equal(result.approx, true);
  assert.equal(result.requests, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].filter.agreementId, null, 'широкий фильтр без agreementId');
}

// --- 9. легитимно пустой продукт не расширяется до чужих операций ---
{
  const calls = stubPages([{ items: [], cursor: null }]);
  const result = await g.collectPages(1, template, period, {
    filterType: 'PAY_CARD',
    agreementId: 'pa_X',
  });
  assert.equal(calls.length, 1, 'без ошибки альтернативу не пробуем');
  assert.equal(result.approx, false);
  assert.equal(result.rows.length, 0);
  assert.equal(result.stopReason, 'empty');
}

// --- 10. onPage получает номер страницы и накопленные строки ---
{
  const seen = [];
  stubPages([
    { items: [dateItem('a', '2026-03-10T12:00:00.000Z')], cursor: 'c2' },
    { items: [dateItem('b', '2026-03-09T12:00:00.000Z')], cursor: null },
  ]);
  await g.collectPages(1, template, period, null, (info) =>
    // Снимок делаем в момент вызова: info.rows — тот же массив, который растёт дальше.
    seen.push([info.page, info.pages, info.rows.length]),
  );
  assert.deepEqual(seen, [
    [1, 1, 1],
    [2, 2, 2],
  ]);
}

// --- 11. ошибка страницы без альтернативы проваливает сбор ---
{
  stubPages([{ error: 'GraphQL: boom' }]);
  await assert.rejects(() => g.collectPages(1, template, period, null), /GraphQL: boom/);
}

console.log('pagination: OK');
