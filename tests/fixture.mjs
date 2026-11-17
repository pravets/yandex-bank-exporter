// Детерминированная фикстура «сырых» операций для независимой проверки отчёта.
// Ожидаемые числа выписаны отдельно, вручную, в tests/expected.json: verifier
// не должен брать эталон из тех же production-преобразований.
import { writeFileSync } from 'node:fs';

const OP_ID = (id) =>
  'FEED_VIEW::LINKED_TRUST_PURCHASE_TOKEN::::::NTQ3OTYyOTgzMjkzMDczOTI=::::false::::V4::' +
  Buffer.from(JSON.stringify([{ type: 'DEPOSIT', operationId: id }]), 'utf8').toString('base64') +
  '::true';

const money = (amount) => ({ money: { amount, currency: 'RUB' }, plus: null });

/** Сырые операции в порядке строк отчёта. */
export const RAW_ITEMS = [
  {
    id: OP_ID('purchase-1'),
    date: '2026-01-10T09:15:00.000Z',
    direction: 'DEBIT',
    title: { plain: 'Магазин у дома' },
    description: 'Супермаркеты',
    statusCode: 'CLEAR',
    amount: money('3.00'),
    summaryCashback: { totalValue: { plus: '0' } },
  },
  {
    id: OP_ID('purchase-2'),
    date: '2026-02-05T18:40:00.000Z',
    direction: 'DEBIT',
    title: { plain: 'Аптека' },
    description: 'Аптеки',
    statusCode: 'CLEAR',
    amount: money('10.50'),
  },
  {
    id: OP_ID('transfer-out'),
    date: '2026-01-20T12:00:00.000Z',
    direction: 'DEBIT',
    title: { plain: 'Иосиф П.' },
    description: 'Перевод',
    statusCode: 'CLEAR',
    amount: money('100.00'),
  },
  {
    id: OP_ID('transfer-in'),
    date: '2026-01-21T12:00:00.000Z',
    direction: 'CREDIT',
    title: { plain: 'Иосиф П.' },
    description: 'Перевод',
    statusCode: 'CLEAR',
    amount: money('25.00'),
  },
  {
    id: OP_ID('internal'),
    date: '2026-03-01T12:00:00.000Z',
    direction: 'DEBIT',
    title: { plain: 'Перевод на накопительный' },
    description: 'Перевод между счетами',
    statusCode: 'CLEAR',
    amount: money('40000.00'),
  },
  {
    id: OP_ID('income'),
    date: '2026-02-25T10:00:00.000Z',
    direction: 'CREDIT',
    title: { plain: 'Проценты' },
    description: 'Пополнение',
    statusCode: 'CLEAR',
    amount: money('0.03'),
  },
  {
    id: OP_ID('cancelled'),
    date: '2026-01-31T20:00:00.000Z',
    direction: 'DEBIT',
    title: { plain: 'Ресторан' },
    description: 'Рестораны и кафе',
    statusCode: 'CANCEL',
    amount: money('7.00'),
  },
  {
    id: OP_ID('points'),
    date: '2026-03-02T10:00:00.000Z',
    direction: 'DEBIT',
    title: { plain: 'Списание баллов' },
    description: 'Списание баллов',
    statusCode: 'CLEAR',
    amount: { money: null, plus: '500.00' },
  },
];

/** Карта/счёт для каждой строки фикстуры (задаётся продуктом, а не банком). */
export const FIXTURE_ACCOUNTS = [
  'Карта Пэй',
  'Карта Пэй',
  'Карта Пэй',
  'Карта Пэй',
  'Счёт',
  'Карта Пэй',
  'Карта Пэй',
  'Карта Пэй',
];

/** Собирает строки фикстуры через production-преобразование (mapItem). */
export function buildFixtureRows(mapItem) {
  return RAW_ITEMS.map((item, index) => ({
    ...mapItem(item),
    account: FIXTURE_ACCOUNTS[index],
  }));
}

/** Пишет книгу фикстуры; возвращает пути и строки. */
export function writeFixtureWorkbook(outPath, api) {
  const rows = buildFixtureRows(api.mapItem);
  const sheets = api.buildSheets(rows, {
    periodLabel: '2026',
    subtitle: 'фикстура для независимой проверки',
    skipped: '',
  });
  writeFileSync(outPath, api.XlsxLite.build(sheets));
  return { file: outPath, rows, sheets };
}
