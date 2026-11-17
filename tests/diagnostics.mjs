// Диагностика: по умолчанию обезличена, полный состав — только по явному флагу.
import assert from 'node:assert/strict';

import { loadPopup } from './load-popup.mjs';

loadPopup();
const g = globalThis;

const body = JSON.stringify({
  operationName: 'GetTransactionFeedView',
  variables: { agreementId: 'pa_SECRET1234', filterType: 'PAY_CARD', size: 50 },
  extensions: { persistedQuery: { sha256Hash: 'abcdef1234567890' } },
});

const capture = {
  body,
  agreementId: 'pa_SECRET1234',
  filterType: 'PAY_CARD',
  responseAt: Date.parse('2026-11-17T10:00:00Z'),
  operations: [
    {
      operationName: 'GetTransactionFeedView',
      hash: 'abcdef1234567890',
      variables: { agreementId: 'pa_SECRET1234', size: 50 },
      at: Date.parse('2026-11-17T10:00:00Z'),
      response: { id: 'raw-response' },
      responseKeys: ['id'],
    },
  ],
  filters: {
    filters: [
      { filterType: 'PAY_CARD', id: 'PAY_CARD-pa_SECRET1234', agreementId: 'pa_SECRET1234', name: 'Карта Пэй', secondName: '90,92 ₽' },
    ],
    savingFilters: [],
    customFilters: [],
  },
  responseSample: {
    items: [
      {
        id: 'raw-item-id',
        title: { plain: 'ООО Ромашка 1234567890' },
        amount: { money: { amount: '9876.54', currency: 'RUB' } },
        rightSubTitle: 'Карта · 0980',
      },
    ],
    paths: ['amount', 'amount.money', 'id'],
    feedKeys: ['items', 'cursor'],
    itemCount: 1,
    request: { agreementId: 'pa_SECRET1234', filterType: 'PAY_CARD' },
  },
};

const tabUrl = 'https://bank.yandex.ru/my/history?filterId=PAY_CARD-pa_SECRET1234';

const masked = g.buildDiagnostics(capture, tabUrl, '1.4.0', Date.parse('2026-11-17T10:05:00Z'));
const maskedText = JSON.stringify(masked);

assert.equal(masked.masked, true);
assert.equal(maskedText.includes('pa_SECRET1234'), false, 'agreementId не утекает');
assert.equal(maskedText.includes('9876.54'), false, 'сумма не утекает');
assert.equal(maskedText.includes('1234567890'), false, 'длинные цифры замаскированы');
assert.equal(maskedText.includes('raw-item-id'), false, 'сырой ID операции не утекает');
assert.equal(maskedText.includes('raw-response'), false, 'сырой ответ не утекает');
assert.equal(masked.tabUrl, 'https://bank.yandex.ru/my/history', 'query без filterId');
assert.equal(masked.request.body.redacted, true);
assert.equal(masked.request.variables.redacted, true);
assert.deepEqual(masked.request.variables.keys, ['agreementId', 'filterType', 'size']);
assert.equal(masked.request.agreementId, '••••1234', 'хвост идентификатора для сверки');
assert.equal(masked.operations[0].response, undefined, 'журнал без тел ответов');
assert.deepEqual(masked.operations[0].variablesKeys, ['agreementId', 'size']);
assert.equal(masked.feedFilters.filters[0].hasAgreementId, true);
assert.equal(maskedText.includes('90,92 ₽'), false, 'баланс из фильтра замаскирован');
// Структура полей нужна диагностике: список путей сохраняется.
assert.ok(masked.paths.includes('amount.money'));

const full = g.buildDiagnostics(
  capture,
  tabUrl,
  '1.4.0',
  Date.parse('2026-11-17T10:05:00Z'),
  { full: true },
);
assert.equal(full.masked, false);
assert.equal(full.request.agreementId, 'pa_SECRET1234');
assert.equal(full.request.body, body);
assert.equal(full.items[0].amount.money.amount, '9876.54');
assert.equal(full.operations[0].response.id, 'raw-response');
assert.equal(full.feedFilters.filters[0].agreementId, 'pa_SECRET1234');
assert.equal(full.tabUrl, tabUrl);

// Формы, которые content script не разобрал, видны в диагностике.
assert.equal(g.buildDiagnostics({ body }, 'https://bank.yandex.ru/').unsupportedForms, 0);
assert.equal(
  g.buildDiagnostics({ body, unsupportedForms: 3 }, 'https://bank.yandex.ru/').unsupportedForms,
  3,
);

console.log('diagnostics: OK');
