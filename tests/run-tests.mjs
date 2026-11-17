// Проверка кода расширения без Chrome: грузим xlsx-lite.js и popup.js в этот процесс,
// собираем отчёт из синтетических "сырых" операций GraphQL и пишем .xlsx.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

import { loadPopup } from './load-popup.mjs';
import { RAW_ITEMS, writeFixtureWorkbook } from './fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Образец отчёта пишем в temp: тест не должен зависеть от прав на рабочую папку
// и не должен засорять репозиторий. Путь можно переопределить через TEST_OUT_FILE.
const outFile = process.env.TEST_OUT_FILE || join(tmpdir(), 'yandex-pay-sample-report.xlsx');

loadPopup({ getElementById: () => null });

if (typeof globalThis.mapItem !== 'function') throw new Error('mapItem не загрузился');
if (typeof globalThis.buildSheets !== 'function') throw new Error('buildSheets не загрузился');
if (typeof globalThis.buildDiagnostics !== 'function') throw new Error('buildDiagnostics не загрузился');
if (!globalThis.XlsxLite) throw new Error('XlsxLite не загрузился');

// ---------- синтетическая лента, повторяющая форму ответа GraphQL ----------
const OP_CHAIN = (opId) =>
  'FEED_VIEW::LINKED_TRUST_PURCHASE_TOKEN::::::NTQ3OTYyOTgzMjkzMDczOTI=::::false::::V4::' +
  btoa(JSON.stringify([{ type: 'DEPOSIT', operationId: opId, operationTimestamp: '2026-01-01T00:00:00Z' }])) +
  '::true';

const CATEGORIES = ['Супермаркеты', 'Яндекс', 'Фастфуд', 'Аптеки', 'Рестораны и кафе'];

function rawItem(index) {
  const day = 1 + Math.floor(index * 5.6);
  const month = 1 + Math.floor(day / 31);
  const date = `2026-${String(Math.min(month, 12)).padStart(2, '0')}-${String((day % 28) + 1).padStart(2, '0')}T${String(9 + (index % 12)).padStart(2, '0')}:${String((index * 7) % 60).padStart(2, '0')}:00.000Z`;

  const statusCode = index % 17 === 0 ? 'FAIL' : index % 23 === 0 ? 'HOLD' : 'CLEAR';
  const base = {
    id: OP_CHAIN('op_' + index),
    date,
    statusCode,
    comment: null,
    rightSubTitle: 'Карта Пэй',
    summaryCashback: null,
    __typename: 'OperationV2',
  };

  switch (index % 7) {
    case 0:
      return {
        ...base,
        direction: 'DEBIT',
        title: { plain: 'Перевод на накопительный' },
        description: 'Перевод между счетами',
        amount: { money: { amount: '40000.00', currency: 'RUB' }, plus: null },
        rightSubTitle: null,
      };
    case 1:
      return {
        ...base,
        direction: 'CREDIT',
        title: { plain: 'Выплата процентов' },
        description: 'Пополнение',
        amount: { money: { amount: '0.03', currency: 'RUB' }, plus: null },
        rightSubTitle: null,
      };
    case 2:
      return {
        ...base,
        direction: 'DEBIT',
        title: { plain: 'Такси' },
        description: 'Списание баллов',
        amount: { money: null, plus: '500.00' },
        rightSubTitle: null,
      };
    case 3:
      return {
        ...base,
        direction: 'DEBIT',
        title: { plain: 'Иосиф П.' },
        description: 'Перевод',
        amount: { money: { amount: '5000.00', currency: 'RUB' }, plus: null },
        rightSubTitle: null,
      };
    default: {
      const category = CATEGORIES[index % CATEGORIES.length];
      return {
        ...base,
        direction: 'DEBIT',
        title: { plain: 'Магазин ' + index },
        description: category,
        amount: { money: { amount: String(100 + index * 13.37).slice(0, 7), currency: 'RUB' }, plus: null },
        summaryCashback: { totalValue: { plus: String((index % 9) * 7) + '.00' } },
      };
    }
  }
}

const items = Array.from({ length: 60 }, (_, index) => rawItem(index));
const rows = items.map(globalThis.mapItem).map((row, index) => ({
  ...row,
  account:
    index % 10 === 0
      ? globalThis.pickAccount(row, null)
      : globalThis.pickAccount(row, new Set([index % 5 === 0 ? 'Счёт' : 'Карта Пэй'])),
}));

// ---------- продукты и подпись карты/счёта ----------
assert.equal(globalThis.filterLabel({ name: 'Карта Пэй', secondName: null }), 'Карта Пэй');
assert.equal(globalThis.filterLabel({ name: 'Счёт', secondName: '90,92 ₽' }), 'Счёт');
assert.equal(globalThis.filterLabel({ name: 'Карта', secondName: '•• 0980' }), 'Карта •• 0980');

const filters = globalThis.availableFilters({
  filters: {
    filters: [
      { filterType: 'ALL', id: 'ALL', name: 'Все' },
      { filterType: 'PAY_CARD', id: 'PAY_CARD-pa_X', name: 'Карта Пэй', agreementId: 'pa_X' },
      {
        filterType: 'SAVING_ACCOUNT',
        id: 'SAVING_ACCOUNT-sa_X',
        name: 'Счёт',
        secondName: '90,92 ₽',
        agreementId: 'sa_X',
      },
    ],
    savingFilters: [],
    customFilters: [{ filterType: 'YANDEX_SERVICES', id: 'YANDEX_SERVICES', name: 'Сервисы Яндекса' }],
  },
});
assert.deepEqual(
  filters.map((filter) => filter.label),
  ['Карта Пэй', 'Счёт'],
);
assert.equal(filters[0].agreementId, 'pa_X');

assert.equal(globalThis.pickAccount({ paymentCard: 'Карта · 0980' }, new Set(['Карта Пэй'])), 'Карта Пэй');
assert.equal(globalThis.pickAccount({ paymentCard: 'Карта · 0980' }, null), 'Не определено');
assert.equal(globalThis.pickAccount({}, new Set(['Счёт', 'Карта Пэй'])), 'Счёт / Карта Пэй');
assert.equal(globalThis.pickAccount({}, null), 'Не определено');

assert.equal(globalThis.isForeignPayment({ paymentCard: 'Карта · 0980' }), true);
assert.equal(globalThis.isForeignPayment({ paymentCard: 'Карта · 2328' }), true);
assert.equal(globalThis.isForeignPayment({ paymentCard: '' }), false);
assert.equal(globalThis.isForeignPayment({ paymentCard: 'Счёт · 1234' }), false);

const sampleRow = globalThis.mapItem({
  id: 'raw-id',
  date: '2026-01-01T00:00:00Z',
  direction: 'DEBIT',
  title: { plain: 'Магазин' },
  description: 'Супермаркеты',
  rightSubTitle: 'Карта · 0980',
  amount: { money: { amount: '1.00', currency: 'RUB' } },
});
assert.equal(sampleRow.rawId, 'raw-id');
assert.equal(sampleRow.paymentCard, 'Карта · 0980');
assert.equal(sampleRow.account, '');
assert.ok(sampleRow.contentKey.includes('2026-01-01T00:00:00Z'));
assert.ok(rows.every((row) => typeof row.account === 'string' && row.account.length > 0));
assert.ok(rows.some((row) => row.account === 'Не определено'));
assert.ok(rows.some((row) => row.account === 'Карта Пэй'));

const sheets = globalThis.buildSheets(rows, {
  periodLabel: '2026',
  subtitle: `Период: тест · операций: ${rows.length}`,
  skipped: '',
});

const bytes = globalThis.XlsxLite.build(sheets);
writeFileSync(outFile, bytes);

const sum = (list, fn) => list.reduce((acc, item) => acc + fn(item), 0);
const ok = rows.filter((row) => row.statusCode === 'CLEAR' || row.statusCode === 'HOLD');
const expected = {
  rows: rows.length,
  expenses: Number(sum(ok.filter((r) => r.kind === 'Расход'), (r) => r.amount).toFixed(2)),
  transfersOut: Number(
    sum(ok.filter((r) => (r.kind === 'Перевод' || r.kind === 'Перевод между счетами') && r.direction !== 'CREDIT'), (r) => r.amount).toFixed(2),
  ),
  income: Number(sum(ok.filter((r) => r.kind === 'Доход'), (r) => r.amount).toFixed(2)),
  cashback: Number(sum(ok, (r) => r.cashback || 0).toFixed(2)),
};

// ---------- диагностический образец ответа ----------
const requestBody = JSON.stringify({
  operationName: 'GetTransactionFeedView',
  variables: { size: 50, agreementId: 'pa_TEST', filterType: 'PAY_CARD' },
  extensions: { persistedQuery: { version: 1, sha256Hash: 'hash' } },
});

const diagnostics = globalThis.buildDiagnostics(
  {
    body: requestBody,
    agreementId: 'pa_TEST',
    filterType: 'PAY_CARD',
    responseAt: Date.parse('2026-11-17T10:00:00Z'),
    operations: [
      {
        operationName: 'GetTransactionFeedView',
        hash: 'hash',
        variables: { size: 50 },
        at: Date.parse('2026-11-17T10:00:00Z'),
        responseKeys: null,
        response: null,
      },
    ],
    responseSample: {
      items: [
        {
          id: 'x',
          rightSubTitle: 'Карта · 0980',
          account: { title: 'Счёт', maskedNumber: '1234' },
        },
      ],
      paths: ['account', 'account.maskedNumber', 'id', 'rightSubTitle'],
      feedKeys: ['items', 'cursor'],
      itemCount: 1,
      request: { agreementId: 'pa_TEST', filterType: 'PAY_CARD' },
    },
  },
  'https://bank.yandex.ru/my/history?filterId=PAY_CARD-1-pa_TEST',
  '1.1.0',
  Date.parse('2026-11-17T10:05:00Z'),
  { full: true },
);

assert.equal(diagnostics.generatedAt, '2026-11-17T10:05:00.000Z');
assert.equal(diagnostics.extensionVersion, '1.1.0');
assert.equal(diagnostics.request.filterIdFromUrl, 'PAY_CARD-1-pa_TEST');
assert.equal(diagnostics.request.agreementId, 'pa_TEST');
assert.equal(diagnostics.request.filterType, 'PAY_CARD');
assert.equal(diagnostics.request.variables.size, 50);
assert.equal(diagnostics.feed.itemCount, 1);
assert.deepEqual(diagnostics.feed.keys, ['items', 'cursor']);
assert.equal(diagnostics.items.length, 1);
assert.equal(diagnostics.operations.length, 1);
assert.equal(diagnostics.operations[0].operationName, 'GetTransactionFeedView');
assert.equal(diagnostics.feedFilters, null);
assert.ok(diagnostics.paths.includes('account.maskedNumber'));

const noSample = globalThis.buildDiagnostics(
  { body: requestBody },
  'https://bank.yandex.ru/',
  '',
  0,
  { full: true },
);
assert.deepEqual(noSample.items, []);
assert.deepEqual(noSample.operations, []);
assert.equal(noSample.feed.itemCount, 0);
assert.equal(noSample.request.agreementId, 'pa_TEST');
assert.equal(noSample.request.filterType, 'PAY_CARD');
assert.equal(noSample.request.filterIdFromUrl, '');
assert.equal(noSample.generatedAt, '1970-01-01T00:00:00.000Z');
assert.deepEqual(noSample.paths, []);

// ---------- календарный контракт в разных локальных зонах ----------
// TZ нельзя надёжно поменять внутри процесса (особенно на Windows), поэтому
// каждый прогон контракта запускается отдельным процессом.
const ZONES = ['Europe/Moscow', 'UTC', 'Asia/Vladivostok', 'America/New_York'];
const skipped = [];
let spawnBlocked = false;
for (const zone of ZONES) {
  const result = spawnSync(process.execPath, [join(here, 'period-contract.mjs'), zone], {
    env: { ...process.env, TZ: zone },
    encoding: 'utf8',
  });
  if (result.error && (result.error.code === 'EPERM' || result.error.code === 'ENOENT')) {
    // Некоторые песочницы запрещают дочерние процессы. Тогда матрицу зон гоняем
    // снаружи: TZ=UTC node tests/run-tests.mjs.
    spawnBlocked = true;
    break;
  }
  if (result.status !== 0) {
    process.stderr.write(
      `period-contract.mjs упал в зоне ${zone} (status ${result.status}):\n` +
        `${result.stderr || ''}${result.stdout || ''}\n`,
    );
    process.exit(1);
  }
}
if (spawnBlocked) {
  skipped.push('period-contract.mjs (матрица зон)');
  process.stderr.write(
    'WARN: матрица часовых зон пропущена — среда не разрешает дочерние процессы. ' +
      'Проверьте вручную: TZ=UTC node tests/run-tests.mjs и TZ=Asia/Vladivostok node tests/run-tests.mjs.\n',
  );
}

// ---------- остальные наборы проверок ----------
// Каждый файл — самостоятельный процесс со своими моками globalThis.
const SUITES = [
  'pagination.mjs',
  'transfers.mjs',
  'money.mjs',
  'dedupe.mjs',
  'xml.mjs',
  'prepare.mjs',
  'busy.mjs',
  'diagnostics.mjs',
  'content.mjs',
  'release-build.mjs',
];
for (const suite of SUITES) {
  const result = spawnSync(process.execPath, [join(here, suite)], { encoding: 'utf8' });
  if (result.error && (result.error.code === 'EPERM' || result.error.code === 'ENOENT')) {
    skipped.push(suite);
    process.stderr.write(`WARN: ${suite} пропущен — среда не разрешает дочерние процессы.\n`);
    continue;
  }
  if (result.status !== 0) {
    process.stderr.write(
      `${suite} упал (status ${result.status}):\n${result.stderr || ''}${result.stdout || ''}\n`,
    );
    process.exit(1);
  }
}
if (skipped.length) {
  process.stderr.write(`WARN: не выполнено проверок: ${skipped.length} (${skipped.join(', ')}).\n`);
}

// ---------- фикстура с независимыми ожиданиями ----------
// Числа в tests/expected.json написаны вручную; verifier сверяет с ними книгу,
// не пересчитывая эталон из тех же production-преобразований.
const fixtureFile =
  process.env.TEST_FIXTURE_FILE || join(tmpdir(), 'yandex-pay-fixture-report.xlsx');
writeFixtureWorkbook(fixtureFile, globalThis);
const expectedFile = join(here, 'expected.json');

/** Запускает python-verifier; песочница может запрещать дочерние процессы. */
function runVerifier(target, expectedPath) {
  const args = [join(here, 'verify.py'), target];
  if (expectedPath) args.push(expectedPath);
  for (const python of ['python', 'python3']) {
    const result = spawnSync(python, args, {
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    if (result.error && result.error.code === 'ENOENT') continue;
    if (result.error) {
      skipped.push(`verify.py (${target})`);
      return 'skipped';
    }
    if (result.status !== 0) {
      process.stderr.write(
        `verify.py упал (${target}):\n${result.stdout || ''}${result.stderr || ''}\n`,
      );
      process.exit(1);
    }
    return 'ok';
  }
  skipped.push(`verify.py (${target})`);
  return 'skipped';
}

const verifierFixture = runVerifier(fixtureFile, expectedFile);
const verifierMain = runVerifier(outFile, null);
if (skipped.length) {
  process.stderr.write(
    `WARN: не выполнено проверок: ${skipped.length} (${skipped.join(', ')}). ` +
      'Проверьте вручную: python tests/verify.py <xlsx> [expected.json].\n',
  );
}

console.log(
  JSON.stringify(
    {
      file: outFile,
      bytes: bytes.length,
      sheets: sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows.length })),
      expected,
      firstRow: sheets[0].rows[1],
      fixtureFile,
      verifier: { fixture: verifierFixture, main: verifierMain },
      skipped,
    },
    null,
    2,
  ),
);
