/* Popup: собирает историю операций со страницы Яндекс Пэя и отдаёт .xlsx */
'use strict';

const $ = (id) => document.getElementById(id);

const STATUS_RU = {
  CLEAR: 'Проведено',
  HOLD: 'Холд',
  FAIL: 'Ошибка',
  CANCEL: 'Отменено',
};
const OK_STATUSES = new Set(['CLEAR', 'HOLD']);
const TRANSFER_CATEGORIES = new Set(['Перевод между счетами', 'Перевод']);
const MONTH_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const PAGE_SIZE = 50;
const MAX_PAGES = 400;

const state = {
  tabId: null,
  tabUrl: '',
  capture: null,
  busy: false,
};

// ------------------------------------------------------------------ утилиты

const mskFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function mskParts(iso) {
  const date = new Date(iso);
  const parts = mskFormat.formatToParts(date);
  const pick = (type) => Number(parts.find((p) => p.type === type).value);
  let hour = pick('hour');
  if (hour === 24) hour = 0;
  return { year: pick('year'), month: pick('month'), day: pick('day'), hour, minute: pick('minute') };
}

function setStatus(text, kind) {
  const node = $('status');
  node.textContent = text;
  node.dataset.kind = kind || 'info';
}

function show(id, visible) {
  $(id).hidden = !visible;
}

function setBusy(busy) {
  state.busy = busy;
  $('run').disabled = busy;
  $('prepare').disabled = busy;
  $('period').disabled = busy;
  $('withTransfers').disabled = busy;
  $('withForeignCards').disabled = busy;
  $('diag').disabled = busy;
}

function progress(value, text) {
  if (value === null) {
    $('bar').classList.add('indeterminate');
    $('bar').style.width = '';
  } else {
    $('bar').classList.remove('indeterminate');
    $('bar').style.width = Math.max(0, Math.min(100, value)) + '%';
  }
  $('pinfo').textContent = text || '';
  show('progress', true);
}

function hideProgress() {
  show('progress', false);
  $('bar').style.width = '0%';
  $('pinfo').textContent = '';
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// ------------------------------------------------------------------ вкладка и перехват

function isBankUrl(url) {
  return typeof url === 'string' && /^https:\/\/bank\.yandex\.ru\//.test(url);
}

async function findTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && isBankUrl(active.url)) return active;
  const candidates = await chrome.tabs.query({ url: 'https://bank.yandex.ru/*' });
  return candidates.length ? candidates[0] : null;
}

async function readCapture(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => window.__yandexPayExportCapture || null,
    });
    return result ? result.result : null;
  } catch (e) {
    return null;
  }
}

async function waitForCapture(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const capture = await readCapture(tabId);
    if (capture && capture.body) return capture;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

/**
 * Один запрос страницы истории выполняется внутри вкладки (MAIN world):
 * так работают cookies и не нужен отдельный бэкенд.
 *
 * `filter` — продукт из GetTransactionsFeedFilters: { filterType, agreementId }.
 * Без фильтра берётся общая лента «Все».
 */
async function fetchPage(tabId, template, cursor, filter) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [template, cursor || null, filter || null],
    func: async (bodyTemplate, nextCursor, selected) => {
      let body;
      try {
        body = JSON.parse(bodyTemplate);
      } catch (e) {
        return { error: 'Не удалось прочитать шаблон запроса' };
      }
      const vars = body.variables || (body.variables = {});
      delete vars.filterType;
      delete vars.agreementId;
      if (selected) {
        if (selected.filterType) vars.filterType = selected.filterType;
        if (selected.agreementId) vars.agreementId = selected.agreementId;
      }
      vars.size = 50;
      if (nextCursor) vars.cursor = nextCursor;
      else delete vars.cursor;

      const persisted = body.extensions && body.extensions.persistedQuery;
      const hash = persisted && persisted.sha256Hash;
      const url = '/graphql' + (hash ? '?operationId=' + encodeURIComponent(hash) : '');

      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        });
      } catch (e) {
        return { error: 'Сеть: ' + e.message };
      }
      if (!response.ok) return { error: 'HTTP ' + response.status };

      let json;
      try {
        json = await response.json();
      } catch (e) {
        return { error: 'Ответ не JSON' };
      }
      if (json.errors && json.errors.length) {
        return { error: 'GraphQL: ' + json.errors[0].message };
      }
      const feed = json.data && json.data.getTransactionsFeedView;
      if (!feed) return { error: 'В ответе нет getTransactionsFeedView' };
      return { items: feed.items || [], cursor: feed.cursor || null };
    },
  });
  return result ? result.result : null;
}

/**
 * Один запрос общей ленты ради сырых операций: нужно понять, какие поля карты/счёта
 * реально приходят от банка. Возвращает до 5 операций как есть.
 */
async function fetchRawSample(tabId, template) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [template],
    func: async (bodyTemplate) => {
      let body;
      try {
        body = JSON.parse(bodyTemplate);
      } catch (e) {
        return { error: 'Не удалось прочитать шаблон запроса' };
      }
      const vars = body.variables || (body.variables = {});
      // Всегда общая лента «Все»: фильтр страницы мог скрыть карту/счёт.
      delete vars.filterType;
      vars.size = 5;
      delete vars.cursor;

      const persisted = body.extensions && body.extensions.persistedQuery;
      const hash = persisted && persisted.sha256Hash;
      const url = '/graphql' + (hash ? '?operationId=' + encodeURIComponent(hash) : '');

      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        });
      } catch (e) {
        return { error: 'Сеть: ' + e.message };
      }
      if (!response.ok) return { error: 'HTTP ' + response.status };

      let json;
      try {
        json = await response.json();
      } catch (e) {
        return { error: 'Ответ не JSON' };
      }
      if (json.errors && json.errors.length) {
        return { error: 'GraphQL: ' + json.errors[0].message };
      }
      const feed = json.data && json.data.getTransactionsFeedView;
      if (!feed) return { error: 'В ответе нет getTransactionsFeedView' };
      return { items: (feed.items || []).slice(0, 5), feedKeys: Object.keys(feed) };
    },
  });
  return result ? result.result : null;
}

// ------------------------------------------------------------------ данные

/**
 * Список продуктов/фильтров истории. Обычно уже перехвачен content script;
 * этот запрос — запасной путь, если ответ не успел прийти.
 */
async function fetchFilters(tabId, template) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [template],
    func: async (bodyTemplate) => {
      let body;
      try {
        body = JSON.parse(bodyTemplate);
      } catch (e) {
        return { error: 'Не удалось прочитать шаблон запроса' };
      }
      const persisted = body.extensions && body.extensions.persistedQuery;
      const hash = persisted && persisted.sha256Hash;
      const url = '/graphql' + (hash ? '?operationId=' + encodeURIComponent(hash) : '');

      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        });
      } catch (e) {
        return { error: 'Сеть: ' + e.message };
      }
      if (!response.ok) return { error: 'HTTP ' + response.status };

      let json;
      try {
        json = await response.json();
      } catch (e) {
        return { error: 'Ответ не JSON' };
      }
      if (json.errors && json.errors.length) {
        return { error: 'GraphQL: ' + json.errors[0].message };
      }
      const data = json.data && json.data.getTransactionsFeedFilters;
      const success = data && data.successData;
      if (!success) return { error: 'В ответе нет getTransactionsFeedFilters' };
      return {
        filters: success.filters || [],
        savingFilters: success.savingFilters || [],
        customFilters: success.customFilters || [],
      };
    },
  });
  return result ? result.result : null;
}

function mapItem(item) {
  let opId = '';
  try {
    const match = /::V4::([A-Za-z0-9+/=]+)::/.exec(item.id || '');
    if (match) {
      const chain = JSON.parse(atob(match[1]));
      const found = chain.find((x) => x && x.operationId);
      if (found) opId = found.operationId;
    }
  } catch (e) {
    /* id необязателен */
  }

  const amount =
    item.amount && item.amount.money ? Number(item.amount.money.amount) : null;
  const points = item.amount && item.amount.plus ? Number(item.amount.plus) : null;
  const cashback =
    item.summaryCashback && item.summaryCashback.totalValue && item.summaryCashback.totalValue.plus
      ? Number(item.summaryCashback.totalValue.plus)
      : null;

  const category = (item.description || '').trim();
  let kind;
  if (amount === null) kind = 'Баллы';
  else if (TRANSFER_CATEGORIES.has(category)) kind = category;
  else kind = item.direction === 'DEBIT' ? 'Расход' : 'Доход';

  const date = mskParts(item.date);
  const time = Date.parse(item.date);
  const direction = item.direction || '';
  const title = ((item.title && item.title.plain) || '').trim();
  const rawId = item.id || '';

  return {
    time,
    year: date.year,
    monthNumber: date.month,
    day: date.day,
    hour: date.hour,
    minute: date.minute,
    monthKey: `${date.year}-${String(date.month).padStart(2, '0')}`,
    title,
    category,
    kind,
    direction,
    amount,
    points: points === null ? null : direction === 'DEBIT' ? -points : points,
    cashback,
    // rightSubTitle — карта оплаты (часто другого банка) или карта контрагента.
    // Это НЕ продукт Яндекс Пэя, поэтому в «Карта / счёт» она не идёт.
    paymentCard: item.rightSubTitle || '',
    account: '',
    status: STATUS_RU[item.statusCode] || item.statusCode || '',
    statusCode: item.statusCode || '',
    opId,
    rawId,
    contentKey: `${item.date}|${amount}|${direction}|${title}`,
    matchKey: rawId || `${item.date}|${amount}|${direction}|${title}`,
  };
}

function getPeriod() {
  const mode = $('period').value;
  const now = new Date();

  if (mode === 'current') {
    return { from: new Date(now.getFullYear(), 0, 1), to: null, label: String(now.getFullYear()) };
  }
  if (mode === 'prev') {
    const year = now.getFullYear() - 1;
    return {
      from: new Date(year, 0, 1),
      to: new Date(year, 11, 31, 23, 59, 59),
      label: String(year),
    };
  }
  if (mode === 'custom') {
    const from = $('dateFrom').value ? new Date($('dateFrom').value + 'T00:00:00') : null;
    const to = $('dateTo').value ? new Date($('dateTo').value + 'T23:59:59') : null;
    const fmt = (d) => (d ? d.toISOString().slice(0, 10) : '');
    return { from, to, label: `${fmt(from) || 'начало'}_${fmt(to) || 'сегодня'}` };
  }
  return { from: null, to: null, label: 'всё время' };
}

function inPeriod(row, period) {
  if (period.from && row.time < period.from.getTime()) return false;
  if (period.to && row.time > period.to.getTime()) return false;
  return true;
}

// ------------------------------------------------------------------ продукты и сбор ленты

/** Подпись карты/счёта из фильтра банка: «Карта Пэй», «Счёт», «Сплит». */
function filterLabel(filter) {
  const name = (filter.name || '').trim() || filter.filterType || '';
  const second = (filter.secondName || '').trim();
  // Второе имя счёта — это баланс («90,92 ₽»), его в подпись не берём.
  if (second && second.indexOf('₽') === -1) return `${name} ${second}`.trim();
  return name;
}

/** Только продуктовые фильтры: карты, счета, Сплит, баллы. Сервисы и «Все» не нужны. */
function availableFilters(capture) {
  const payload = capture && capture.filters;
  if (!payload) return [];

  const seen = new Set();
  const out = [];
  const add = (filter) => {
    if (!filter || !filter.filterType) return;
    if (
      filter.filterType === 'ALL' ||
      filter.filterType === 'YANDEX_SERVICES' ||
      filter.filterType === 'YANDEX_SERVICE_FILTER'
    ) {
      return;
    }
    const key = `${filter.filterType}|${filter.agreementId || ''}|${filter.id || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      filterType: filter.filterType,
      agreementId: filter.agreementId || null,
      id: filter.id || '',
      label: filterLabel(filter),
    });
  };

  (payload.filters || []).forEach(add);
  (payload.savingFilters || []).forEach(add);
  return out;
}

/** Карта/счёт для строки: только продукт Яндекс Пэя из фильтров истории. */
function pickAccount(row, labels) {
  if (labels && labels.size) return [...labels].join(' / ');
  return 'Не определено';
}

/**
 * Операция оплачена картой другого банка: rightSubTitle вида «Карта · 0980».
 * Такие траты уже учтены в выписках других банков, по умолчанию их скрываем.
 */
function isForeignPayment(row) {
  return /^Карта\s*[·•]\s*\d{4}$/.test((row && row.paymentCard) || '');
}

/**
 * Листает ленту до начала периода. Для продуктового фильтра сначала проверяет,
 * какую форму фильтра принимает банк (filterType+agreementId, затем по отдельности).
 */
async function collectPages(tabId, template, period, filter, onPage) {
  const rows = [];
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  let active = filter || null;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let result = await fetchPage(tabId, template, cursor, active);

    if (page === 1 && filter && (!result || result.error || !(result.items || []).length)) {
      const alternatives = [];
      if (filter.filterType) alternatives.push({ filterType: filter.filterType, agreementId: null });
      if (filter.agreementId) alternatives.push({ filterType: null, agreementId: filter.agreementId });
      for (const alternative of alternatives) {
        const probe = await fetchPage(tabId, template, null, alternative);
        if (probe && !probe.error && (probe.items || []).length) {
          active = alternative;
          result = probe;
          break;
        }
      }
    }

    if (!result) throw new Error('Страница не отвечает');
    if (result.error) throw new Error(result.error);

    const items = result.items || [];
    if (!items.length) break;

    for (const item of items) {
      const row = mapItem(item);
      if (seen.has(row.matchKey)) continue;
      seen.add(row.matchKey);
      rows.push(row);
    }

    pages = page;
    if (onPage) onPage({ page, rows, pages });

    const oldest = items[items.length - 1].date;
    if (period.from && Date.parse(oldest) < period.from.getTime()) break;
    if (!result.cursor) break;
    cursor = result.cursor;
    if (filter) await new Promise((resolve) => setTimeout(resolve, 60));
  }

  return { rows, pages };
}

// ------------------------------------------------------------------ Excel

function buildSheets(rows, meta) {
  const S = XlsxLite.STYLE;
  const ops = [];
  const header = [
    '№',
    'Дата',
    'Время',
    'Месяц',
    'Описание',
    'Категория',
    'Тип',
    'Сумма, ₽',
    'Баллы',
    'Кешбэк, баллы',
    'Карта / счёт',
    'Статус',
    'ID операции',
  ];
  ops.push(header.map((text) => ({ v: text, s: S.HEADER })));

  rows.forEach((row, index) => {
    const zebra = index % 2 === 1;
    const style = (normal, striped) => (zebra ? striped : normal);
    ops.push([
      { v: index + 1, s: style(S.CENTER, S.ZEBRA_CENTER) },
      {
        v: XlsxLite.dateSerial(row.year, row.monthNumber, row.day, row.hour, row.minute),
        s: style(S.DATE, S.ZEBRA_DATE),
      },
      { v: XlsxLite.timeFraction(row.hour, row.minute), s: style(S.TIME, S.ZEBRA_TIME) },
      { v: row.monthKey, s: style(S.TEXT, S.ZEBRA_TEXT) },
      { v: row.title, s: style(S.TEXT, S.ZEBRA_TEXT) },
      { v: row.category, s: style(S.TEXT, S.ZEBRA_TEXT) },
      { v: row.kind, s: style(S.TEXT, S.ZEBRA_TEXT) },
      row.amount === null ? null : { v: row.amount, s: style(S.MONEY, S.ZEBRA_MONEY) },
      row.points === null ? null : { v: row.points, s: style(S.MONEY, S.ZEBRA_MONEY) },
      row.cashback === null ? null : { v: row.cashback, s: style(S.MONEY, S.ZEBRA_MONEY) },
      { v: row.account, s: style(S.TEXT, S.ZEBRA_TEXT) },
      { v: row.status, s: style(S.TEXT, S.ZEBRA_TEXT) },
      { v: row.opId, s: style(S.TEXT, S.ZEBRA_TEXT) },
    ]);
  });

  const operations = {
    name: 'Операции',
    rows: ops,
    widths: [6, 12, 9, 10, 34, 24, 21, 14, 11, 15, 22, 12, 28],
    rowHeights: [30],
    freeze: { rows: 1, cols: 0 },
    autoFilter: `A1:M${ops.length}`,
  };

  // ---------- сводка ----------
  const ok = rows.filter((row) => OK_STATUSES.has(row.statusCode));
  const months = [...new Set(rows.map((row) => row.monthKey))].sort();

  const perMonth = new Map();
  for (const month of months) {
    perMonth.set(month, { exp: 0, trOut: 0, inc: 0, trIn: 0, cb: 0, n: 0 });
  }
  const perCategory = new Map();
  const totals = { exp: 0, trOut: 0, inc: 0, trIn: 0, cb: 0, pointsSpent: 0, pointsEarned: 0 };

  for (const row of ok) {
    const bucket = perMonth.get(row.monthKey);
    bucket.n += 1;
    if (row.kind === 'Расход') {
      bucket.exp += row.amount || 0;
      totals.exp += row.amount || 0;
      const cat = row.category || '(без категории)';
      const entry = perCategory.get(cat) || { exp: 0, n: 0 };
      entry.exp += row.amount || 0;
      entry.n += 1;
      perCategory.set(cat, entry);
    } else if (TRANSFER_CATEGORIES.has(row.kind)) {
      if (row.amount !== null) {
        if (row.direction === 'CREDIT') {
          bucket.trIn += row.amount;
          totals.trIn += row.amount;
        } else {
          bucket.trOut += row.amount;
          totals.trOut += row.amount;
        }
      }
    } else if (row.kind === 'Доход') {
      bucket.inc += row.amount || 0;
      totals.inc += row.amount || 0;
    }
    if (row.cashback) {
      bucket.cb += row.cashback;
      totals.cb += row.cashback;
    }
    if (row.points) {
      if (row.points < 0) totals.pointsSpent += -row.points;
      else totals.pointsEarned += row.points;
    }
  }

  const summary = [];
  summary.push([{ v: `Яндекс Пэй — операции за ${meta.periodLabel}`, s: S.TITLE }]);
  summary.push([{ v: meta.subtitle, s: S.MUTED }]);
  summary.push([]);

  summary.push([
    { v: 'Итоги', s: S.BOLD },
    null,
    null,
    { v: 'Месяц', s: S.HEADER },
    { v: 'Операций', s: S.HEADER },
    { v: 'Расходы, ₽', s: S.HEADER },
    { v: 'Переводы исх., ₽', s: S.HEADER },
    { v: 'Поступления, ₽', s: S.HEADER },
    { v: 'Кешбэк, баллы', s: S.HEADER },
  ]);

  const kpi = [
    ['Расходы (покупки и услуги), ₽', round2(totals.exp)],
    ['Переводы исходящие, ₽', round2(totals.trOut)],
    ['Всего списаний, ₽', round2(totals.exp + totals.trOut)],
    ['Поступления (доходы), ₽', round2(totals.inc)],
    ['Переводы входящие, ₽', round2(totals.trIn)],
    ['Кешбэк начислено, баллы', round2(totals.cb)],
    ['Списано баллов', round2(totals.pointsSpent)],
    ['Начислено баллов', round2(totals.pointsEarned)],
  ];

  const bodyRows = Math.max(kpi.length, months.length);
  for (let i = 0; i < bodyRows; i += 1) {
    const line = [];
    if (i < kpi.length) {
      line[0] = { v: kpi[i][0], s: S.BOLD };
      line[1] = { v: kpi[i][1], s: S.BOLD_MONEY_PLAIN };
    }
    if (i < months.length) {
      const month = months[i];
      const data = perMonth.get(month);
      const [year, monthNumber] = month.split('-');
      line[3] = { v: `${MONTH_RU[Number(monthNumber) - 1]} ${year}`, s: S.TEXT };
      line[4] = { v: data.n, s: S.CENTER };
      line[5] = { v: round2(data.exp), s: S.MONEY };
      line[6] = { v: round2(data.trOut), s: S.MONEY };
      line[7] = { v: round2(data.inc), s: S.MONEY };
      line[8] = { v: round2(data.cb), s: S.MONEY };
    }
    summary.push(line);
  }

  summary.push([
    { v: 'Итого', s: S.TOTAL_LABEL },
    null,
    null,
    null,
    { v: ok.length, s: S.TOTAL_LABEL },
    { v: round2(totals.exp), s: S.TOTAL_MONEY },
    { v: round2(totals.trOut), s: S.TOTAL_MONEY },
    { v: round2(totals.inc), s: S.TOTAL_MONEY },
    { v: round2(totals.cb), s: S.TOTAL_MONEY },
  ]);

  if (meta.skipped) {
    summary.push([]);
    summary.push([{ v: meta.skipped, s: S.MUTED }]);
  }

  const categories = [...perCategory.entries()].sort((a, b) => b[1].exp - a[1].exp);
  summary.push([]);
  summary.push([{ v: 'Категории расходов (без переводов)', s: S.BOLD }]);
  summary.push([
    { v: 'Категория', s: S.HEADER_BORDERED },
    { v: 'Сумма, ₽', s: S.HEADER_BORDERED },
    { v: 'Операций', s: S.HEADER_BORDERED },
    { v: 'Доля', s: S.HEADER_BORDERED },
  ]);
  for (const [name, data] of categories) {
    summary.push([
      { v: name, s: S.TEXT },
      { v: round2(data.exp), s: S.MONEY },
      { v: data.n, s: S.CENTER },
      { v: totals.exp ? data.exp / totals.exp : 0, s: S.PERCENT },
    ]);
  }

  return [
    operations,
    { name: 'Сводка', rows: summary, widths: [34, 16, 3, 12, 11, 14, 14, 14, 14] },
  ];
}

async function downloadBlob(bytes, mime, filename) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, saveAs: false });
  } catch (e) {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  return bytes.length;
}

async function downloadWorkbook(sheets, filename) {
  const bytes = XlsxLite.build(sheets);
  return downloadBlob(
    bytes,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename,
  );
}

// ------------------------------------------------------------------ диагностика

function hasResponseSample(capture) {
  return !!(
    capture &&
    capture.responseSample &&
    Array.isArray(capture.responseSample.items) &&
    capture.responseSample.items.length
  );
}

function collectKeyPaths(items) {
  const paths = new Set();
  const walk = (value, prefix, depth) => {
    if (!value || typeof value !== 'object' || depth > 4) return;
    if (Array.isArray(value)) {
      if (value.length) walk(value[0], prefix + '[]', depth + 1);
      return;
    }
    for (const key of Object.keys(value)) {
      const path = prefix ? prefix + '.' + key : key;
      paths.add(path);
      walk(value[key], path, depth + 1);
    }
  };
  for (const item of items || []) walk(item, '', 0);
  return [...paths].sort();
}

function filterIdFromUrl(url) {
  const match = /[?&]filterId=([^&]+)/.exec(url || '');
  return match ? decodeURIComponent(match[1]) : '';
}

/** Чистая сборка диагностического JSON: без chrome, DOM и сети — удобно тестировать. */
function buildDiagnostics(capture, tabUrl, version, now) {
  const sample = (capture && capture.responseSample) || null;
  const items = sample && Array.isArray(sample.items) ? sample.items : [];
  let parsedBody = null;
  try {
    parsedBody = capture && capture.body ? JSON.parse(capture.body) : null;
  } catch (e) {
    parsedBody = null;
  }
  const request = (sample && sample.request) || {};
  const vars = (parsedBody && parsedBody.variables) || {};
  const at = capture && capture.responseAt ? capture.responseAt : now;
  return {
    generatedAt: new Date(now == null ? Date.now() : now).toISOString(),
    extensionVersion: version || '',
    tabUrl: tabUrl || '',
    request: {
      filterIdFromUrl: filterIdFromUrl(tabUrl),
      agreementId: request.agreementId || (capture && capture.agreementId) || vars.agreementId || '',
      filterType: request.filterType || (capture && capture.filterType) || vars.filterType || null,
      variables: (parsedBody && parsedBody.variables) || null,
      body: (capture && capture.body) || null,
    },
    feed: {
      keys: (sample && sample.feedKeys) || [],
      itemCount: sample ? sample.itemCount : 0,
      sampledAt: at ? new Date(at).toISOString() : '',
    },
    items,
    operations:
      capture && Array.isArray(capture.operations) ? capture.operations : [],
    feedFilters: (capture && capture.filters) || null,
    paths:
      sample && Array.isArray(sample.paths) && sample.paths.length
        ? sample.paths
        : collectKeyPaths(items),
  };
}

function refreshDiagnostics() {
  show('diag', hasResponseSample(state.capture));
}

/** Снимок фильтров карт/счетов из интерфейса истории: ссылки и подписи. */
async function readHistoryFilters(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const out = [];
      const seen = new Set();
      const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const push = (el) => {
        const text = textOf(el);
        const href = el.href || '';
        const match = /[?&]filterId=([^&]+)/.exec(href);
        const filterId = match ? decodeURIComponent(match[1]) : el.getAttribute('data-filter-id') || '';
        if (!text && !filterId) return;
        const key = text + '|' + filterId + '|' + href;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
          text,
          filterId,
          href: href.slice(0, 300),
          testId: el.getAttribute('data-testid') || '',
          role: el.getAttribute('role') || '',
          tag: el.tagName.toLowerCase(),
        });
      };
      document.querySelectorAll('a[href*="filterId"],[data-filter-id]').forEach(push);
      document
        .querySelectorAll('button,[role="tab"],[role="option"],[role="radio"],label')
        .forEach(push);
      return {
        url: location.href,
        title: document.title,
        candidates: out.slice(0, 80),
      };
    },
  });
  return result ? result.result : null;
}

async function downloadDiagnostics() {
  if (state.busy) return;

  const fresh = state.tabId ? await readCapture(state.tabId) : null;
  let capture = fresh || state.capture;
  if (!capture || !capture.body) {
    setStatus('Сначала откройте страницу истории платежей — без неё образец не собрать.', 'warn');
    return;
  }

  setStatus('Запрашиваю образец ответа…', 'info');
  if (state.tabId) {
    const sample = await fetchRawSample(state.tabId, capture.body);
    if (sample && !sample.error && Array.isArray(sample.items) && sample.items.length) {
      capture = {
        ...capture,
        responseAt: Date.now(),
        responseSample: {
          items: sample.items,
          paths: collectKeyPaths(sample.items),
          feedKeys: sample.feedKeys || [],
          itemCount: sample.items.length,
          request: { agreementId: capture.agreementId || '', filterType: null },
        },
      };
    } else if (!hasResponseSample(capture)) {
      setStatus(
        (sample && sample.error) || 'Не удалось получить образец ответа. Обновите страницу истории и повторите.',
        'error',
      );
      return;
    }
  }

  if (!hasResponseSample(capture)) {
    setStatus(
      'Образец ответа ещё не пойман. Обновите страницу истории платежей и откройте попап снова.',
      'warn',
    );
    return;
  }

  state.capture = capture;
  let version = '';
  try {
    version = chrome.runtime.getManifest().version;
  } catch (e) {
    version = '';
  }

  const data = buildDiagnostics(capture, state.tabUrl, version, Date.now());
  if (state.tabId) {
    try {
      data.pageFilters = await readHistoryFilters(state.tabId);
    } catch (e) {
      data.pageFilters = { error: e && e.message ? e.message : String(e) };
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `yandex-pay-sample-${stamp}.json`;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
    await downloadBlob(bytes, 'application/json', filename);
    setStatus(
      `Образец сохранён: ${filename}. Внутри реальные операции — файл никуда не отправляется.`,
      'ok',
    );
  } catch (error) {
    setStatus(
      'Не удалось сохранить образец: ' + (error && error.message ? error.message : error),
      'error',
    );
  }
}

// ------------------------------------------------------------------ основной сценарий

async function run() {
  if (state.busy) return;
  if (!state.tabId) {
    setStatus('Сначала откройте страницу истории платежей — без неё расширение не узнает параметры запроса.', 'warn');
    return;
  }

  // Живой снимок страницы: к моменту экспорта там уже есть и тело запроса, и фильтры.
  const fresh = await readCapture(state.tabId);
  const capture = fresh || state.capture;
  if (!capture || !capture.body) {
    setStatus('Сначала откройте страницу истории платежей — без неё расширение не узнает параметры запроса.', 'warn');
    return;
  }
  state.capture = capture;

  setBusy(true);
  hideProgress();
  show('retry', false);

  try {
    const period = getPeriod();
    const includeTransfers = $('withTransfers').checked;
    const includeForeignCards = $('withForeignCards').checked;

    // Если автоперехват фильтров не успел — запрашиваем список продуктов сами.
    if ((!capture.filters || !Array.isArray(capture.filters.filters)) && capture.filtersBody) {
      const fetched = await fetchFilters(state.tabId, capture.filtersBody);
      if (fetched && !fetched.error) {
        capture.filters = {
          filters: fetched.filters || [],
          savingFilters: fetched.savingFilters || [],
          customFilters: fetched.customFilters || [],
        };
        state.capture = capture;
      }
    }

    const products = availableFilters(capture);

    setStatus('Собираю операции…', 'info');
    progress(null, 'Запрос 1…');

    const base = await collectPages(state.tabId, capture.body, period, null, ({ page, rows }) => {
      progress(Math.min(70, 8 + page * 3), `Страница ${page} · операций: ${rows.length}`);
    });

    if (!base.rows.length) throw new Error('История пуста — проверьте, что открыт правильный аккаунт');

    // Карта/счёт определяется тем, в какой продуктовый фильтр попала операция.
    const labelsByKey = new Map();
    const addLabel = (row, label) => {
      for (const key of [row.rawId, row.contentKey]) {
        if (!key) continue;
        const set = labelsByKey.get(key) || new Set();
        set.add(label);
        labelsByKey.set(key, set);
      }
    };

    const filterFailures = [];
    let pages = base.pages;
    for (let index = 0; index < products.length; index += 1) {
      const product = products[index];
      progress(
        Math.min(95, 70 + (index / Math.max(1, products.length)) * 25),
        `Уточняю: ${product.label} (${index + 1}/${products.length})`,
      );
      try {
        const part = await collectPages(state.tabId, capture.body, period, product);
        pages += part.pages;
        for (const row of part.rows) addLabel(row, product.label);
      } catch (error) {
        filterFailures.push(`${product.label}: ${error.message || error}`);
      }
    }

    const inScope = base.rows.filter(
      (row) => inPeriod(row, period) && (includeTransfers || !TRANSFER_CATEGORIES.has(row.kind)),
    );
    const foreignTotal = inScope.filter(isForeignPayment).length;
    const foreignCount = includeForeignCards ? 0 : foreignTotal;
    const rows = inScope
      .filter((row) => includeForeignCards || !isForeignPayment(row))
      .map((row) => {
        const labels = labelsByKey.get(row.rawId) || labelsByKey.get(row.contentKey);
        return { ...row, account: pickAccount(row, labels) };
      });

    if (!rows.length) {
      if (foreignTotal) {
        throw new Error(
          'Все операции за период оплачены картами других банков. Включите «Включать операции с карт других банков» или выберите другой период.',
        );
      }
      throw new Error('За выбранный период операций нет — попробуйте другой диапазон');
    }

    const unknown = rows.filter((row) => row.account === 'Не определено').length;
    const failed = rows.filter((row) => !OK_STATUSES.has(row.statusCode)).length;
    const first = rows[rows.length - 1];
    const last = rows[0];
    const subtitle =
      `Период: ${String(first.day).padStart(2, '0')}.${String(first.monthNumber).padStart(2, '0')}.${first.year} — ` +
      `${String(last.day).padStart(2, '0')}.${String(last.monthNumber).padStart(2, '0')}.${last.year} · ` +
      `операций: ${rows.length} · страниц: ${pages}` +
      (failed ? ` · не проведено: ${failed}` : '') +
      (unknown ? ` · карта/счёт не определены: ${unknown}` : '') +
      (foreignCount
        ? ` · с внешних карт скрыто: ${foreignCount}`
        : includeForeignCards && foreignTotal
          ? ` · с внешних карт: ${foreignTotal}`
          : '');

    const notes = [];
    if (failed) notes.push(`Строк в статусах «Ошибка»/«Отменено»: ${failed}; в итоги не включены.`);
    if (unknown) notes.push(`Без карты/счёта: ${unknown}.`);
    if (foreignCount) notes.push(`Скрыто операций с карт других банков: ${foreignCount}.`);
    else if (includeForeignCards && foreignTotal) {
      notes.push(`Включены операции с карт других банков: ${foreignTotal}.`);
    }
    if (filterFailures.length) notes.push(`Не удалось уточнить: ${filterFailures.join('; ')}.`);
    if (!products.length) notes.push('Список карт/счетов не получен — обновите страницу истории и повторите.');

    progress(97, 'Формирую Excel…');

    const sheets = buildSheets(rows, {
      periodLabel: period.label,
      subtitle,
      skipped: notes.join(' '),
    });

    const filename = `Яндекс_Пэй_${period.label.replace(/[^\w.\-]+/g, '_')}.xlsx`;
    const size = await downloadWorkbook(sheets, filename);

    progress(100, `Готово: ${filename} (${Math.round(size / 1024)} КБ)`);
    setStatus(
      `Экспортировано операций: ${rows.length}. ` +
        (unknown ? `Карта/счёт не определены у ${unknown}. ` : 'Карта/счёт определены у всех. ') +
        (foreignCount ? `Скрыто операций с карт других банков: ${foreignCount}. ` : '') +
        `Файл «${filename}» сохранён в загрузки.`,
      'ok',
    );
  } catch (error) {
    hideProgress();
    setStatus(error && error.message ? error.message : String(error), 'error');
    show('retry', true);
  } finally {
    if (state.tabId) {
      try {
        const latest = await readCapture(state.tabId);
        if (latest) state.capture = latest;
      } catch (e) {
        /* образец необязателен */
      }
    }
    refreshDiagnostics();
    setBusy(false);
  }
}

async function prepare() {
  if (state.busy) return;
  if (!state.tabId) {
    await locateTab();
    return;
  }

  setBusy(true);
  hideProgress();
  show('retry', false);
  const onHistory = /\/my\/history/.test(state.tabUrl || '');
  setStatus(onHistory ? 'Обновляю страницу истории…' : 'Открываю историю платежей…', 'info');

  try {
    if (onHistory) {
      await chrome.tabs.reload(state.tabId);
    } else {
      await chrome.tabs.update(state.tabId, {
        url: 'https://bank.yandex.ru/my/history',
      });
    }
    const capture = await waitForCapture(state.tabId, 20000);
    if (!capture || !capture.body) {
      throw new Error('Не дождался загрузки истории. Проверьте, что вы вошли в аккаунт, и нажмите «Повторить».');
    }
    state.capture = capture;
    refreshDiagnostics();
    setStatus('Страница готова — можно собирать операции.', 'ok');
    show('controls', true);
    show('run', true);
    show('prepare', false);
  } catch (error) {
    setStatus(error.message || String(error), 'error');
    show('retry', true);
  } finally {
    setBusy(false);
  }
}

async function locateTab() {
  show('retry', false);
  hideProgress();
  setStatus('Проверяю вкладку…', 'info');

  const tab = await findTab();
  if (!tab) {
    setStatus('Откройте https://bank.yandex.ru и войдите в аккаунт — расширение работает только на этой странице.', 'error');
    show('prepare', false);
    show('run', false);
    show('controls', false);
    refreshDiagnostics();
    return;
  }

  state.tabId = tab.id;
  state.tabUrl = tab.url || '';

  const capture = await waitForCapture(tab.id, 1500);
  if (capture && capture.body) {
    state.capture = capture;
    refreshDiagnostics();
    setStatus('Страница истории найдена.', 'ok');
    show('controls', true);
    show('run', true);
    show('prepare', false);
  } else {
    state.capture = null;
    refreshDiagnostics();
    const onHistory = /\/my\/history/.test(state.tabUrl);
    setStatus(
      onHistory
        ? 'Похоже, страница открыта до установки расширения. Обновите её — и можно выгружать.'
        : 'Откройте историю платежей: расширение подхватит запрос автоматически.',
      'warn',
    );
    show('controls', false);
    show('run', false);
    show('prepare', true);
    $('prepare').textContent = onHistory ? 'Обновить страницу' : 'Открыть историю';
  }
}

let initialized = false;

function init() {
  if (initialized) return;
  initialized = true;
  const now = new Date();
  $('optCurrent').textContent = `Текущий год (${now.getFullYear()})`;
  $('optPrev').textContent = `Прошлый год (${now.getFullYear() - 1})`;
  $('dateFrom').value = `${now.getFullYear()}-01-01`;
  $('dateTo').value = now.toISOString().slice(0, 10);

  $('period').addEventListener('change', () => {
    show('dates', $('period').value === 'custom');
  });
  $('run').addEventListener('click', run);
  $('prepare').addEventListener('click', prepare);
  $('retry').addEventListener('click', locateTab);
  $('diag').addEventListener('click', downloadDiagnostics);

  locateTab();
}

document.addEventListener('DOMContentLoaded', init);
if (document.readyState !== 'loading') init();
