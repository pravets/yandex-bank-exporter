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
// Категория банка, которая означает перевод между своими счетами.
const INTERNAL_TRANSFER_CATEGORY = 'Перевод между счетами';
// Переводы для агрегации в сводке: и внутренние, и обычные.
const TRANSFER_CATEGORIES = new Set([INTERNAL_TRANSFER_CATEGORY, 'Перевод']);
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

// МСК — фиксированный UTC+3, перехода на летнее время нет. Поэтому московский
// календарный день переводится в момент времени простым смещением, без локальной
// зоны браузера: Date.UTC(y, m - 1, d) - 3 ч.
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

const mskFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function mskPartsFromDate(date) {
  const parts = mskFormat.formatToParts(date);
  const pick = (type) => Number(parts.find((p) => p.type === type).value);
  let hour = pick('hour');
  if (hour === 24) hour = 0;
  return { year: pick('year'), month: pick('month'), day: pick('day'), hour, minute: pick('minute') };
}

function mskParts(iso) {
  return mskPartsFromDate(new Date(iso));
}

/** Начало московского календарного дня (00:00:00.000 МСК) как момент времени. */
function mskDayStart(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - MSK_OFFSET_MS);
}

/** Начало следующего московского дня — исключительная верхняя граница периода. */
function mskDayAfter(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1) - MSK_OFFSET_MS);
}

/** Строгий разбор значения <input type="date">: "YYYY-MM-DD" -> части дня по МСК. */
function parseMskInputDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = mskDayStart({ year, month, day });
  const back = mskPartsFromDate(probe);
  if (back.year !== year || back.month !== month || back.day !== day) return null;
  return { year, month, day };
}

/** Значение <input type="date"> для текущего московского дня. */
function mskDateInputValue(date) {
  const parts = mskPartsFromDate(date);
  const pad = (value) => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Значения по умолчанию: начало текущего МСК-года и текущий МСК-день. */
function defaultDateRange(now = new Date()) {
  const today = mskPartsFromDate(now);
  return { from: `${today.year}-01-01`, to: mskDateInputValue(now) };
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
  const full = $('diagFull');
  if (full) full.disabled = busy;
}

/**
 * Захватывает блокировку синхронно, до первого await: иначе два быстрых клика
 * проходят проверку `state.busy` одновременно и запускают две операции.
 * Возвращает false, если операция уже идёт.
 */
function tryBeginBusy() {
  if (state.busy) return false;
  setBusy(true);
  return true;
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

/**
 * Округление денег до копеек, half-up по десятичному представлению.
 * `(10.075).toFixed(2)` даёт 10.07 из-за двоичного представления, поэтому
 * масштабируем и срезаем двоичный шум через toPrecision, и только потом округляем.
 */
function round2(value) {
  if (!Number.isFinite(value)) return value;
  const scaled = Number((Math.abs(value) * 100).toPrecision(15));
  return Math.sign(value) * (Math.round(scaled) / 100);
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

async function waitForCapture(tabId, timeoutMs, accept) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const capture = await readCapture(tabId);
    if (capture && capture.body && (!accept || (await accept(capture)))) return capture;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

/** Origin текущего документа вкладки: отличает старый снимок от свежего. */
async function readPageTimeOrigin(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => performance.timeOrigin,
    });
    return result ? result.result : null;
  } catch (e) {
    return null;
  }
}

/**
 * Снимок годится, только если он сделан после команды обновления и принадлежит
 * текущему документу вкладки. Одного сравнения времени мало: старый документ
 * может ответить позже, поэтому сверяем ещё и origin загрузки.
 */
function isFreshCapture(capture, t0, liveOrigin) {
  if (!capture || !capture.body) return false;
  if (!Number.isFinite(capture.at) || capture.at < t0) return false;
  if (liveOrigin == null || capture.pageTimeOrigin == null) return false;
  return capture.pageTimeOrigin === liveOrigin;
}

/**
 * Один GraphQL-запрос выполняется внутри вкладки (MAIN world): так работают
 * cookies и сессия банка, и не нужен отдельный бэкенд.
 *
 * Единственная точка исполнения запросов: пагинация, образец ответа и список
 * фильтров отличаются только `spec`, а не копией обвязки.
 *
 * spec:
 *   filter    — { filterType, agreementId }; null удаляет переменные фильтра,
 *               undefined оставляет их как в шаблоне;
 *   size      — размер страницы (переменная `size`);
 *   cursor    — курсор; null удаляет его из переменных;
 *   timeoutMs — дедлайн запроса, по умолчанию 30 с.
 *
 * Возвращает { json } или { error, code }:
 * template | network | timeout | http | json | graphql | inject.
 */
async function graphql(tabId, bodyTemplate, spec) {
  const options = spec || {};
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [bodyTemplate, options],
      func: async (bodyTemplateInPage, specInPage) => {
        const timeoutMs = (specInPage && specInPage.timeoutMs) || 30000;
        let body;
        try {
          body = JSON.parse(bodyTemplateInPage);
        } catch (e) {
          return { error: 'Не удалось прочитать шаблон запроса', code: 'template' };
        }

        const vars = body.variables || (body.variables = {});
        if (specInPage && 'filter' in specInPage) {
          delete vars.filterType;
          delete vars.agreementId;
          const filter = specInPage.filter;
          if (filter) {
            if (filter.filterType) vars.filterType = filter.filterType;
            if (filter.agreementId) vars.agreementId = filter.agreementId;
          }
        }
        if (specInPage && specInPage.size) vars.size = specInPage.size;
        if (specInPage && 'cursor' in specInPage) {
          if (specInPage.cursor) vars.cursor = specInPage.cursor;
          else delete vars.cursor;
        }

        const persisted = body.extensions && body.extensions.persistedQuery;
        const hash = persisted && persisted.sha256Hash;
        const url = '/graphql' + (hash ? '?operationId=' + encodeURIComponent(hash) : '');

        // Дедлайн покрывает и ожидание ответа, и чтение тела: зависший запрос
        // банка не должен держать попап занятым до закрытия вкладки.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          let response;
          try {
            response = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify(body),
              signal: controller.signal,
            });
          } catch (e) {
            const aborted = e && (e.name === 'AbortError' || controller.signal.aborted);
            return aborted
              ? { error: 'Таймаут запроса к банку', code: 'timeout' }
              : { error: 'Сеть: ' + (e && e.message ? e.message : e), code: 'network' };
          }
          if (!response.ok) {
            return { error: 'HTTP ' + response.status, code: 'http', status: response.status };
          }
          let json;
          try {
            json = await response.json();
          } catch (e) {
            return controller.signal.aborted
              ? { error: 'Таймаут чтения ответа', code: 'timeout' }
              : { error: 'Ответ не JSON', code: 'json' };
          }
          if (json.errors && json.errors.length) {
            return { error: 'GraphQL: ' + json.errors[0].message, code: 'graphql' };
          }
          return { json };
        } finally {
          clearTimeout(timer);
        }
      },
    });
    return result && result.result
      ? result.result
      : { error: 'Вкладка не вернула ответ', code: 'inject' };
  } catch (e) {
    // Ошибка executeScript (вкладка закрыта, нет прав) не должна улетать наружу.
    return {
      error: 'Не удалось выполнить запрос во вкладке: ' + (e && e.message ? e.message : e),
      code: 'inject',
    };
  }
}

/**
 * Страница истории. `filter` — продукт из GetTransactionsFeedFilters.
 * Без фильтра берётся общая лента «Все».
 */
async function fetchPage(tabId, template, cursor, filter) {
  const response = await graphql(tabId, template, {
    filter: filter || null,
    size: PAGE_SIZE,
    cursor: cursor || null,
  });
  if (response.error) return { error: response.error };
  const feed = response.json && response.json.data && response.json.data.getTransactionsFeedView;
  if (!feed) return { error: 'В ответе нет getTransactionsFeedView' };
  return { items: feed.items || [], cursor: feed.cursor || null };
}

/**
 * Один запрос общей ленты ради сырых операций: нужно понять, какие поля карты/счёта
 * реально приходят от банка. Возвращает до 5 операций как есть.
 */
async function fetchRawSample(tabId, template) {
  const response = await graphql(tabId, template, { filter: null, size: 5, cursor: null });
  if (response.error) return { error: response.error };
  const feed = response.json && response.json.data && response.json.data.getTransactionsFeedView;
  if (!feed) return { error: 'В ответе нет getTransactionsFeedView' };
  return { items: (feed.items || []).slice(0, 5), feedKeys: Object.keys(feed) };
}

// ------------------------------------------------------------------ данные

/**
 * Список продуктов/фильтров истории. Обычно уже перехвачен content script;
 * этот запрос — запасной путь, если ответ не успел прийти.
 */
async function fetchFilters(tabId, template) {
  const response = await graphql(tabId, template, {});
  if (response.error) return { error: response.error };
  const data = response.json && response.json.data && response.json.data.getTransactionsFeedFilters;
  const success = data && data.successData;
  if (!success) return { error: 'В ответе нет getTransactionsFeedFilters' };
  return {
    filters: success.filters || [],
    savingFilters: success.savingFilters || [],
    customFilters: success.customFilters || [],
  };
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

  const money = item.amount && item.amount.money ? item.amount.money : null;
  const pointsRaw = item.amount && item.amount.plus != null ? Number(item.amount.plus) : null;
  const cashbackRaw =
    item.summaryCashback && item.summaryCashback.totalValue && item.summaryCashback.totalValue.plus
      ? Number(item.summaryCashback.totalValue.plus)
      : null;

  const category = (item.description || '').trim();
  const direction = item.direction || '';
  let dataError = '';
  let amount = null;
  let points = pointsRaw;
  let cashback = cashbackRaw;
  let currency = '';

  if (money) {
    currency = money.currency || '';
    const parsed = Number(money.amount);
    if (!Number.isFinite(parsed)) dataError = 'некорректная сумма';
    else amount = parsed;
    if (!dataError && currency && currency !== 'RUB') dataError = `валюта ${currency}`;
  }
  if (points !== null && !Number.isFinite(points)) {
    dataError = dataError || 'некорректные баллы';
    points = null;
  }
  if (cashback !== null && !Number.isFinite(cashback)) {
    dataError = dataError || 'некорректный кешбэк';
    cashback = null;
  }

  const time = Date.parse(item.date);
  if (!Number.isFinite(time)) dataError = dataError || 'некорректная дата';
  // Без корректной даты нечего класть в календарные поля: зануляем и помечаем строку.
  const date = Number.isFinite(time)
    ? mskParts(item.date)
    : { year: 0, month: 0, day: 0, hour: 0, minute: 0 };

  let kind;
  if (money) {
    kind = TRANSFER_CATEGORIES.has(category)
      ? category
      : direction === 'DEBIT'
        ? 'Расход'
        : 'Доход';
  } else {
    kind = 'Баллы';
  }

  const title = ((item.title && item.title.plain) || '').trim();
  const rawId = item.id || '';
  // Отпечаток включает категорию и статус: записи без ID, различающиеся ими, не склеиваются.
  const fingerprint = `${item.date}|${amount}|${direction}|${title}|${category}|${item.statusCode || ''}`;

  return {
    time,
    year: date.year,
    monthNumber: date.month,
    day: date.day,
    hour: date.hour,
    minute: date.minute,
    monthKey: Number.isFinite(time)
      ? `${date.year}-${String(date.month).padStart(2, '0')}`
      : '',
    title,
    category,
    kind,
    direction,
    currency,
    amount,
    points: points === null ? null : direction === 'DEBIT' ? -points : points,
    cashback,
    // rightSubTitle — карта оплаты (часто другого банка) или карта контрагента.
    // Это НЕ продукт Яндекс Пэя, поэтому в «Карта / счёт» она не идёт.
    paymentCard: item.rightSubTitle || '',
    account: '',
    status: STATUS_RU[item.statusCode] || item.statusCode || '',
    statusCode: item.statusCode || '',
    // Пустая строка — запись пригодна для расчётов; иначе причина и исключение из итогов.
    dataError,
    opId,
    rawId,
    contentKey: fingerprint,
    matchKey: rawId || fingerprint,
  };
}

/** Перевод между своими счетами (а не обычный перевод контрагенту). */
function isInternalTransfer(row) {
  return !!row && row.kind === INTERNAL_TRANSFER_CATEGORY;
}

/**
 * Галочка «Включать переводы между счетами» управляет только внутренними
 * переводами: обычные переводы контрагентам и дальше попадают в выгрузку.
 */
function shouldIncludeRow(row, includeTransfers) {
  return includeTransfers || !isInternalTransfer(row);
}

/** Человеческое направление операции для колонки отчёта. */
function directionLabel(row) {
  if (!row) return '';
  if (row.direction === 'DEBIT') return 'Списание';
  if (row.direction === 'CREDIT') return 'Поступление';
  return '';
}

/**
 * Период экспорта — всегда московские календарные дни.
 * Интервал полуоткрытый: [from, toExclusive); null означает открытую границу.
 */
function getPeriod(now = new Date()) {
  const mode = $('period').value;
  const year = mskPartsFromDate(now).year;

  if (mode === 'current') {
    return {
      from: mskDayStart({ year, month: 1, day: 1 }),
      toExclusive: null,
      label: String(year),
      invalidReason: null,
    };
  }
  if (mode === 'prev') {
    const prevYear = year - 1;
    return {
      from: mskDayStart({ year: prevYear, month: 1, day: 1 }),
      toExclusive: mskDayStart({ year, month: 1, day: 1 }),
      label: String(prevYear),
      invalidReason: null,
    };
  }
  if (mode === 'custom') {
    const rawFrom = $('dateFrom').value.trim();
    const rawTo = $('dateTo').value.trim();
    const label = `${rawFrom || 'начало'}_${rawTo || 'сегодня'}`;

    if (rawFrom && !parseMskInputDay(rawFrom)) {
      return { from: null, toExclusive: null, label, invalidReason: 'Некорректная дата в поле «С».' };
    }
    if (rawTo && !parseMskInputDay(rawTo)) {
      return { from: null, toExclusive: null, label, invalidReason: 'Некорректная дата в поле «По».' };
    }

    const from = rawFrom ? mskDayStart(parseMskInputDay(rawFrom)) : null;
    const toExclusive = rawTo ? mskDayAfter(parseMskInputDay(rawTo)) : null;
    const invalidReason =
      from && toExclusive && from.getTime() >= toExclusive.getTime()
        ? 'Период задан в обратном порядке: «С» позже «По». Исправьте даты.'
        : null;

    return { from, toExclusive, label, invalidReason };
  }
  return { from: null, toExclusive: null, label: 'всё время', invalidReason: null };
}

function inPeriod(row, period) {
  if (!Number.isFinite(row.time)) return !(period.from || period.toExclusive);
  if (period.from && row.time < period.from.getTime()) return false;
  if (period.toExclusive && row.time >= period.toExclusive.getTime()) return false;
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
 * Листает ленту до начала периода.
 *
 * Возвращает не только строки, но и полноту результата: `complete === false`
 * означает, что лента оборвалась на лимите страниц или курсор перестал двигаться,
 * и вызывающий обязан показать это пользователю, а не выдавать выгрузку за полную.
 *
 * Для продуктового фильтра сначала проверяет, какую форму фильтра принимает банк.
 * Проба альтернативной формы делается только при ошибке/отсутствии ответа:
 * легитимно пустая история продукта не расширяется до чужих операций.
 */
async function collectPages(tabId, template, period, filter, onPage) {
  const rows = [];
  const seen = new Set();
  const seenCursors = new Set();
  let duplicates = 0;
  let cursor = null;
  let pages = 0;
  let probes = 0;
  let stopReason = 'limit';
  let approx = false;
  let active = filter || null;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let result = await fetchPage(tabId, template, cursor, active);

    if (page === 1 && filter && (!result || result.error)) {
      const alternatives = [];
      if (filter.filterType) alternatives.push({ filterType: filter.filterType, agreementId: null });
      if (filter.agreementId) alternatives.push({ filterType: null, agreementId: filter.agreementId });
      for (const alternative of alternatives) {
        probes += 1;
        const probe = await fetchPage(tabId, template, null, alternative);
        if (probe && !probe.error && (probe.items || []).length) {
          active = alternative;
          result = probe;
          // Сработала широкая форма фильтра: продукт определён приблизительно.
          approx = true;
          break;
        }
      }
    }

    if (!result) throw new Error('Страница не отвечает');
    if (result.error) throw new Error(result.error);

    const items = result.items || [];
    if (!items.length) {
      stopReason = 'empty';
      break;
    }

    let added = 0;
    for (const item of items) {
      const row = mapItem(item);
      if (seen.has(row.matchKey)) {
        duplicates += 1;
        continue;
      }
      seen.add(row.matchKey);
      rows.push(row);
      added += 1;
    }

    pages = page;
    if (onPage) onPage({ page, rows, pages });

    const oldest = items[items.length - 1].date;
    if (period.from && Date.parse(oldest) < period.from.getTime()) {
      stopReason = 'period';
      break;
    }
    if (!result.cursor) {
      stopReason = 'end';
      break;
    }
    // Тот же курсор или страница без единой новой строки: дальше не продвигаемся.
    if (seenCursors.has(result.cursor) || added === 0) {
      stopReason = 'no-progress';
      break;
    }
    seenCursors.add(result.cursor);
    cursor = result.cursor;
    if (filter) await new Promise((resolve) => setTimeout(resolve, 60));
  }

  return {
    rows,
    pages,
    requests: pages + probes,
    duplicates,
    stopReason,
    complete: stopReason === 'end' || stopReason === 'period' || stopReason === 'empty',
    approx,
  };
}

/** Человеческая причина неполной выгрузки. */
function stopReasonText(reason) {
  if (reason === 'limit') return 'достигнут лимит страниц';
  if (reason === 'no-progress') return 'курсор не продвигается';
  return 'лента не дочитана';
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
    'Направление',
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
      { v: directionLabel(row), s: style(S.TEXT, S.ZEBRA_TEXT) },
      row.amount === null ? null : { v: row.amount, s: style(S.MONEY, S.ZEBRA_MONEY) },
      row.points === null ? null : { v: row.points, s: style(S.MONEY, S.ZEBRA_MONEY) },
      row.cashback === null ? null : { v: row.cashback, s: style(S.MONEY, S.ZEBRA_MONEY) },
      { v: row.account, s: style(S.TEXT, S.ZEBRA_TEXT) },
      {
        v: row.dataError ? `Некорректные данные: ${row.dataError}` : row.status,
        s: style(S.TEXT, S.ZEBRA_TEXT),
      },
      { v: row.opId, s: style(S.TEXT, S.ZEBRA_TEXT) },
    ]);
  });

  const operations = {
    name: 'Операции',
    rows: ops,
    widths: [6, 12, 9, 10, 34, 24, 21, 13, 14, 11, 15, 22, 12, 28],
    rowHeights: [30],
    freeze: { rows: 1, cols: 0 },
    autoFilter: `A1:N${ops.length}`,
  };

  // ---------- сводка ----------
  // В итоги идут только проведённые операции с пригодными данными и датой.
  const ok = rows.filter(
    (row) => OK_STATUSES.has(row.statusCode) && !row.dataError && Number.isFinite(row.time),
  );
  const months = [...new Set(ok.map((row) => row.monthKey))].sort();

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

/**
 * Часть имени файла: сохраняем буквы (включая кириллицу), цифры, точку, дефис и
 * подчёркивание. Всё остальное — включая запрещённые файловой системой символы —
 * заменяем на "_". Пустой результат превращаем в "период".
 */
function sanitizeFilePart(text) {
  const cleaned = String(text == null ? '' : text)
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return cleaned || 'период';
}

function buildReportFilename(periodLabel) {
  return `Яндекс_Пэй_${sanitizeFilePart(periodLabel)}.xlsx`;
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

/** Маскирует идентификаторы, оставляя только хвост для сверки версии контракта. */
function maskId(value) {
  const text = String(value == null ? '' : value);
  if (!text) return '';
  return text.length <= 4 ? '••••' : '••••' + text.slice(-4);
}

/** Маскирует длинные цифровые последовательности (номера карт и счетов). */
function maskText(value, limit) {
  return String(value == null ? '' : value)
    .replace(/\d{4,}/g, '••••')
    .slice(0, limit || 60);
}

/**
 * Рекурсивно маскирует значения, сохраняя структуру полей.
 * Идентификаторы (id, agreementId, номер карты) маскируются целиком, числа —
 * тоже: в обезличенном образце нужны имена полей, а не суммы.
 */
const SENSITIVE_KEY = /^(id|agreementId|filterId|operationId|maskedNumber|cardNumber|pan|token|sessionId)$/i;

function maskValue(value, depth, key) {
  if (typeof value === 'string') {
    if (key && SENSITIVE_KEY.test(key)) return maskId(value);
    return maskText(value, 60);
  }
  if (typeof value === 'number') return '••••';
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '…';
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => maskValue(entry, depth + 1, key));
  const out = {};
  for (const field of Object.keys(value)) out[field] = maskValue(value[field], depth + 1, field);
  return out;
}

function maskFilter(filter) {
  return {
    filterType: (filter && filter.filterType) || '',
    id: filter && filter.id ? maskId(filter.id) : '',
    hasAgreementId: !!(filter && filter.agreementId),
    name: maskText((filter && filter.name) || '', 40),
    secondName: filter && filter.secondName ? '••••' : null,
  };
}

/**
 * Чистая сборка диагностического JSON: без chrome, DOM и сети — удобно тестировать.
 *
 * По умолчанию файл обезличен: структура полей и имена операций, но без сумм,
 * номеров карт, agreementId и тела запроса. Полный состав — только по явному
 * запросу (`options.full`), с предупреждением в интерфейсе.
 */
function buildDiagnostics(capture, tabUrl, version, now, options) {
  const full = !!(options && options.full);
  const sample = (capture && capture.responseSample) || null;
  const rawItems = sample && Array.isArray(sample.items) ? sample.items : [];
  const items = full ? rawItems : rawItems.map((item) => maskValue(item, 0));

  let parsedBody = null;
  try {
    parsedBody = capture && capture.body ? JSON.parse(capture.body) : null;
  } catch (e) {
    parsedBody = null;
  }
  const request = (sample && sample.request) || {};
  const vars = (parsedBody && parsedBody.variables) || {};
  const at = capture && capture.responseAt ? capture.responseAt : now;
  const agreementId = request.agreementId || (capture && capture.agreementId) || vars.agreementId || '';
  const filterId = filterIdFromUrl(tabUrl);

  const operations = capture && Array.isArray(capture.operations) ? capture.operations : [];
  const journal = full
    ? operations
    : operations.map((entry) => ({
        operationName: entry.operationName || '',
        hash: entry.hash ? maskId(entry.hash) : '',
        variablesKeys:
          entry.variables && typeof entry.variables === 'object'
            ? Object.keys(entry.variables)
            : [],
        at: entry.at || null,
        responseSkipped: !!entry.responseSkipped,
        responseKeys: Array.isArray(entry.responseKeys) ? entry.responseKeys.slice(0, 40) : null,
      }));

  const filters = (capture && capture.filters) || null;
  const feedFilters =
    full || !filters
      ? filters
      : {
          filters: (filters.filters || []).map(maskFilter),
          savingFilters: (filters.savingFilters || []).map(maskFilter),
          customFilters: (filters.customFilters || []).map(maskFilter),
        };

  return {
    generatedAt: new Date(now == null ? Date.now() : now).toISOString(),
    extensionVersion: version || '',
    masked: !full,
    // В обезличенном режиме query-строка отбрасывается: в ней filterId.
    tabUrl: full ? tabUrl || '' : String(tabUrl || '').split('?')[0],
    request: {
      filterIdFromUrl: filterId ? (full ? filterId : maskId(filterId)) : '',
      agreementId: full ? agreementId : maskId(agreementId),
      filterType: request.filterType || (capture && capture.filterType) || vars.filterType || null,
      variables: full
        ? (parsedBody && parsedBody.variables) || null
        : {
            redacted: true,
            keys: parsedBody && parsedBody.variables ? Object.keys(parsedBody.variables) : [],
          },
      body: full
        ? (capture && capture.body) || null
        : { redacted: true, length: capture && capture.body ? capture.body.length : 0 },
    },
    feed: {
      keys: (sample && sample.feedKeys) || [],
      itemCount: sample ? sample.itemCount : 0,
      sampledAt: at ? new Date(at).toISOString() : '',
    },
    items,
    operations: journal,
    feedFilters,
    unsupportedForms: (capture && capture.unsupportedForms) || 0,
    paths:
      sample && Array.isArray(sample.paths) && sample.paths.length
        ? sample.paths
        : collectKeyPaths(rawItems),
  };
}

function maskPageFilters(pageFilters) {
  if (!pageFilters || pageFilters.error) return pageFilters;
  return {
    url: String(pageFilters.url || '').split('?')[0],
    title: maskText(pageFilters.title || '', 60),
    candidates: (pageFilters.candidates || []).map((candidate) => ({
      text: maskText(candidate.text, 60),
      testId: candidate.testId || '',
      role: candidate.role || '',
      tag: candidate.tag || '',
    })),
  };
}

function refreshDiagnostics() {
  const ready = hasResponseSample(state.capture);
  show('diag', ready);
  show('diagFullWrap', ready);
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
  // Блокировка берётся синхронно, до первого await — как у экспорта.
  if (!tryBeginBusy()) return;

  try {
    const fresh = state.tabId ? await readCapture(state.tabId) : null;
    let capture = fresh || state.capture;
    if (!capture || !capture.body) {
      setStatus('Сначала откройте страницу истории платежей — без неё образец не собрать.', 'warn');
      return;
    }

    if (state.tabId) {
      setStatus('Запрашиваю образец ответа…', 'info');
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
          (sample && sample.error) ||
            'Не удалось получить образец ответа. Обновите страницу истории и повторите.',
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

    const fullNode = $('diagFull');
    const full = !!(fullNode && fullNode.checked);
    const data = buildDiagnostics(capture, state.tabUrl, version, Date.now(), { full });

    if (state.tabId) {
      try {
        const pageFilters = await readHistoryFilters(state.tabId);
        data.pageFilters = full ? pageFilters : maskPageFilters(pageFilters);
      } catch (e) {
        data.pageFilters = { error: e && e.message ? e.message : String(e) };
      }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `yandex-pay-sample-${stamp}${full ? '-full' : ''}.json`;
    const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
    await downloadBlob(bytes, 'application/json', filename);
    setStatus(
      full
        ? `Полный образец сохранён: ${filename}. Внутри реальные операции и параметры — файл никуда не отправляется.`
        : `Обезличенный образец сохранён: ${filename}. Суммы, номера и идентификаторы замаскированы; файл никуда не отправляется.`,
      'ok',
    );
  } catch (error) {
    setStatus(
      'Не удалось собрать образец: ' + (error && error.message ? error.message : error),
      'error',
    );
  } finally {
    setBusy(false);
  }
}

// ------------------------------------------------------------------ основной сценарий

async function run() {
  // Блокировку берём до первого await: иначе два вызова проходят проверку
  // одновременно и запускают два скачивания.
  if (!tryBeginBusy()) return;

  hideProgress();
  show('retry', false);

  try {
    // Календарный контракт МСК проверяем до любых сетевых запросов истории.
    const period = getPeriod();
    if (period.invalidReason) {
      setStatus(period.invalidReason, 'error');
      return;
    }

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
    const incomplete = [];
    const approxKeys = new Set();
    let pages = base.pages;
    let requests = base.requests;
    let duplicates = base.duplicates;
    if (!base.complete) incomplete.push(`общая лента (${stopReasonText(base.stopReason)})`);

    for (let index = 0; index < products.length; index += 1) {
      const product = products[index];
      progress(
        Math.min(95, 70 + (index / Math.max(1, products.length)) * 25),
        `Уточняю: ${product.label} (${index + 1}/${products.length})`,
      );
      try {
        const part = await collectPages(state.tabId, capture.body, period, product);
        pages += part.pages;
        requests += part.requests;
        duplicates += part.duplicates;
        if (!part.complete) {
          incomplete.push(`${product.label} (${stopReasonText(part.stopReason)})`);
        }
        for (const row of part.rows) {
          addLabel(row, product.label);
          if (part.approx) {
            if (row.rawId) approxKeys.add(row.rawId);
            approxKeys.add(row.contentKey);
          }
        }
      } catch (error) {
        filterFailures.push(`${product.label}: ${error.message || error}`);
      }
    }

    // Галочка «переводы между счетами» выключает только внутренние переводы,
    // обычные переводы контрагентам остаются в выгрузке.
    const inScope = base.rows.filter(
      (row) => inPeriod(row, period) && shouldIncludeRow(row, includeTransfers),
    );
    const foreignTotal = inScope.filter(isForeignPayment).length;
    const foreignCount = includeForeignCards ? 0 : foreignTotal;
    const rows = inScope
      .filter((row) => includeForeignCards || !isForeignPayment(row))
      .map((row) => {
        const labels = labelsByKey.get(row.rawId) || labelsByKey.get(row.contentKey);
        const approx = approxKeys.has(row.rawId) || approxKeys.has(row.contentKey);
        return { ...row, account: pickAccount(row, labels), accountApprox: approx };
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
    const invalid = rows.filter((row) => !!row.dataError).length;
    const approximate = rows.filter(
      (row) => row.accountApprox && row.account !== 'Не определено',
    ).length;
    const missingId = rows.filter((row) => !row.rawId).length;
    // Диапазон строим по строкам с корректной датой: битые даты не должны давать «00.00.0».
    const dated = rows.filter((row) => Number.isFinite(row.time) && row.monthKey);
    const first = dated.length ? dated[dated.length - 1] : null;
    const last = dated.length ? dated[0] : null;
    const rangeText =
      first && last
        ? `Период: ${String(first.day).padStart(2, '0')}.${String(first.monthNumber).padStart(2, '0')}.${first.year} — ` +
          `${String(last.day).padStart(2, '0')}.${String(last.monthNumber).padStart(2, '0')}.${last.year} · `
        : '';
    const subtitle =
      rangeText +
      `операций: ${rows.length} · страниц: ${pages} · запросов: ${requests}` +
      (failed ? ` · не проведено: ${failed}` : '') +
      (invalid ? ` · ошибка данных: ${invalid}` : '') +
      (unknown ? ` · карта/счёт не определены: ${unknown}` : '') +
      (approximate ? ` · продукт приблизительно: ${approximate}` : '') +
      (incomplete.length ? ' · результат неполный' : '') +
      (foreignCount
        ? ` · с внешних карт скрыто: ${foreignCount}`
        : includeForeignCards && foreignTotal
          ? ` · с внешних карт: ${foreignTotal}`
          : '');

    const notes = [];
    if (failed) notes.push(`Строк в статусах «Ошибка»/«Отменено»: ${failed}; в итоги не включены.`);
    if (invalid) notes.push(`Строк с некорректными данными (в итоги не включены): ${invalid}.`);
    if (unknown) notes.push(`Без карты/счёта: ${unknown}.`);
    if (approximate) {
      notes.push(
        `Карта/счёт определены приблизительно (банк принял только широкую форму фильтра): ${approximate}.`,
      );
    }
    if (missingId) notes.push(`Операций без ID: ${missingId}; дедупликация по отпечатку записи.`);
    if (duplicates) notes.push(`Отброшено дубликатов: ${duplicates}.`);
    if (incomplete.length) {
      notes.push(
        `Результат неполный: ${incomplete.join('; ')}. Выгрузка может быть неполной за выбранный период.`,
      );
    }
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

    const filename = buildReportFilename(period.label);
    const size = await downloadWorkbook(sheets, filename);

    progress(100, `Готово: ${filename} (${Math.round(size / 1024)} КБ)`);
    const incompleteNotice = incomplete.length
      ? `Внимание: результат неполный (${incomplete.join('; ')}). `
      : '';
    setStatus(
      incompleteNotice +
        `Экспортировано операций: ${rows.length}. ` +
        (unknown ? `Карта/счёт не определены у ${unknown}. ` : 'Карта/счёт определены у всех. ') +
        (invalid ? `С некорректными данными: ${invalid}. ` : '') +
        (foreignCount ? `Скрыто операций с карт других банков: ${foreignCount}. ` : '') +
        `Файл «${filename}» сохранён в загрузки.`,
      incomplete.length ? 'warn' : 'ok',
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
  // Блокировка до первого await: locateTab() внутри тоже ждёт вкладку.
  if (!tryBeginBusy()) return;

  hideProgress();
  show('retry', false);

  try {
    if (!state.tabId) {
      await locateTab();
      return;
    }

    const onHistory = /\/my\/history/.test(state.tabUrl || '');
    setStatus(onHistory ? 'Обновляю страницу истории…' : 'Открываю историю платежей…', 'info');

    // Запоминаем момент до команды: снимок старше него — это данные прошлой загрузки.
    const t0 = Date.now();
    if (onHistory) {
      await chrome.tabs.reload(state.tabId);
    } else {
      await chrome.tabs.update(state.tabId, {
        url: 'https://bank.yandex.ru/my/history',
      });
    }
    const capture = await waitForCapture(state.tabId, 20000, async (candidate) => {
      const liveOrigin = await readPageTimeOrigin(state.tabId);
      return isFreshCapture(candidate, t0, liveOrigin);
    });
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
  const today = mskPartsFromDate(now);
  const defaults = defaultDateRange(now);
  $('optCurrent').textContent = `Текущий год (${today.year})`;
  $('optPrev').textContent = `Прошлый год (${today.year - 1})`;
  $('dateFrom').value = defaults.from;
  $('dateTo').value = defaults.to;

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
