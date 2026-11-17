/**
 * Content script (MAIN world, document_start).
 *
 * Задача: перехватить GraphQL-запрос истории операций, который делает сам Яндекс Пэй,
 * и запомнить его тело. Хэш persisted query и agreementId меняются между релизами,
 * поэтому мы не хардкодим их, а переиспользуем то, что отправило приложение.
 *
 * Дополнительно сохраняем небольшой образец САМОГО ОТВЕТА (3 операции + список полей)
 * и журнал ВСЕХ GraphQL-операций страницы (имя, переменные, обрезанный ответ).
 * Это нужно для диагностики: попап умеет выгрузить всё в JSON, чтобы понять, какие
 * поля карты/счёта банк реально отдаёт. Данные живут только в памяти вкладки.
 */
(() => {
  const KEY = '__yandexPayExportCapture';
  if (window[KEY]) return;

  const SAMPLE_ITEMS = 3;
  const SAMPLE_STRING_LIMIT = 2000;
  const SAMPLE_SIZE_LIMIT = 150 * 1024;
  const MAX_OPERATIONS = 12;
  const OPERATION_RESPONSE_LIMIT = 30 * 1024;

  const capture = {
    body: null, // исходный JSON-строкой
    agreementId: null,
    filterType: null,
    at: 0,
    // Время загрузки документа: попап отличает свежий снимок от снимка прошлой загрузки.
    pageTimeOrigin: typeof performance !== 'undefined' ? performance.timeOrigin : 0,
    // Сколько GraphQL-запросов пришло в форме, которую мы не разбираем (не строка).
    unsupportedForms: 0,
    // ответ банка (необязателен): используется только для диагностики
    responseAt: 0,
    responseSample: null,
    responseMeta: null,
    // журнал GraphQL-запросов страницы: имя, переменные, обрезанный ответ
    operations: [],
    // список продуктов/фильтров истории (GetTransactionsFeedFilters)
    filtersBody: null,
    filters: null,
    filtersAt: 0,
  };
  window[KEY] = capture;

  // Запасной вариант: agreementId виден в URL истории (?filterId=PAY_CARD-...-pa_XXX).
  const fromUrl = /pa_[A-Za-z0-9]+/.exec(location.search || '');
  if (fromUrl) capture.agreementId = fromUrl[0];

  // Обрезаем длинные строки: образец должен оставаться маленьким.
  function trimDeep(value, depth) {
    if (typeof value === 'string') {
      return value.length > SAMPLE_STRING_LIMIT ? value.slice(0, SAMPLE_STRING_LIMIT) + '…' : value;
    }
    if (value === null || typeof value !== 'object' || depth >= 8) return value;
    if (Array.isArray(value)) return value.slice(0, 50).map((entry) => trimDeep(entry, depth + 1));
    const out = {};
    for (const key of Object.keys(value)) out[key] = trimDeep(value[key], depth + 1);
    return out;
  }

  // Пути вида `account.title`, `items[].card.mask` — чтобы глазами найти нужное поле.
  function collectPaths(items) {
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
    for (const item of items) walk(item, '', 0);
    return [...paths].sort();
  }

  function captureResponse(json, request) {
    const feed = json && json.data && json.data.getTransactionsFeedView;
    if (!feed || !Array.isArray(feed.items) || !feed.items.length) return;

    const items = feed.items.slice(0, SAMPLE_ITEMS).map((item) => trimDeep(item, 0));
    const sample = {
      items,
      paths: collectPaths(items),
      feedKeys: Object.keys(feed),
      itemCount: feed.items.length,
      request,
    };
    // Совсем неожиданно огромный item — оставляем только первую операцию.
    if (JSON.stringify(sample).length > SAMPLE_SIZE_LIMIT) {
      sample.items = sample.items.slice(0, 1);
      sample.paths = collectPaths(sample.items);
    }

    capture.responseSample = sample;
    capture.responseMeta = {
      at: Date.now(),
      feedKeys: sample.feedKeys,
      itemCount: sample.itemCount,
      request,
    };
    capture.responseAt = capture.responseMeta.at;
  }

  function recordOperation(record) {
    try {
      capture.operations.push(record);
      while (capture.operations.length > MAX_OPERATIONS) capture.operations.shift();
    } catch (e) {
      /* журнал необязателен */
    }
  }

  function captureFilters(json) {
    try {
      const data = json && json.data && json.data.getTransactionsFeedFilters;
      const success = data && data.successData;
      if (!success) return;
      const pick = (filter) =>
        filter && {
          filterType: filter.filterType || '',
          agreementId: filter.agreementId || null,
          id: filter.id || '',
          name: filter.name || '',
          secondName: filter.secondName || null,
        };
      capture.filters = {
        filters: (success.filters || []).map(pick).filter(Boolean),
        savingFilters: (success.savingFilters || []).map(pick).filter(Boolean),
        customFilters: (success.customFilters || []).map(pick).filter(Boolean),
      };
      capture.filtersAt = Date.now();
    } catch (e) {
      /* список фильтров необязателен */
    }
  }

  function recordOperationResponse(record, json) {
    try {
      const cleaned = trimDeep(json, 0);
      record.responseKeys = collectPaths([cleaned]);
      const serialized = JSON.stringify(cleaned);
      record.response =
        serialized.length > OPERATION_RESPONSE_LIMIT
          ? { truncated: true, note: 'Ответ больше лимита, сохранены только пути полей' }
          : cleaned;
    } catch (e) {
      record.responseKeys = null;
      record.response = null;
    }
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function () {
      const args = arguments;
      let feedMeta = null;
      let record = null;

      try {
        const input = args[0];
        const init = args[1];
        let url = '';
        let rawBody = null;
        let method = 'GET';

        if (typeof input === 'string') {
          url = input;
          method = (init && init.method) || 'GET';
        } else if (input && typeof input === 'object') {
          // fetch(new URL(...)) и fetch(new Request(...)): URL и метод берём из объекта.
          if (typeof input.href === 'string') url = input.href;
          else if (typeof input.url === 'string') url = input.url;
          method = (init && init.method) || input.method || 'GET';
        }
        if (init && typeof init.body === 'string') rawBody = init.body;

        const isGraphql = url && url.indexOf('/graphql') !== -1;
        if (isGraphql && String(method).toUpperCase() === 'POST') {
          if (rawBody == null) {
            // Тело не строка (FormData/Blob/поток): перехватить форму нельзя,
            // но это видно в диагностике, а не молчит.
            capture.unsupportedForms = (capture.unsupportedForms || 0) + 1;
          } else {
            const parsed = JSON.parse(rawBody);
            const vars = (parsed && parsed.variables) || {};
            const persisted = parsed && parsed.extensions && parsed.extensions.persistedQuery;

            record = {
              operationName: (parsed && parsed.operationName) || '',
              hash: (persisted && persisted.sha256Hash) || '',
              variables: trimDeep(vars, 0),
              at: Date.now(),
              responseKeys: null,
              response: null,
            };
            recordOperation(record);

            if (rawBody.indexOf('GetTransactionsFeedFilters') !== -1) {
              capture.filtersBody = rawBody;
              record.kind = 'filters';
            }

            if (rawBody.indexOf('GetTransactionFeedView') !== -1) {
              capture.body = rawBody;
              capture.agreementId = vars.agreementId || capture.agreementId;
              capture.filterType = vars.filterType || null;
              capture.at = Date.now();
              feedMeta = {
                agreementId: vars.agreementId || null,
                filterType: vars.filterType || null,
              };
            }
          }
        }
      } catch (e) {
        /* молча: чужой запрос не должен ломаться из-за нас */
      }

      const pending = originalFetch.apply(this, args);

      // Ответ читаем только у распознанной целевой операции: для чужих запросов
      // clone()/json() тратили бы CPU и память на разбор всего ответа.
      const shouldReadResponse = !!(feedMeta || (record && record.kind === 'filters'));
      if (record && !shouldReadResponse) record.responseSkipped = true;

      if (shouldReadResponse && pending && typeof pending.then === 'function') {
        try {
          pending
            .then((response) => {
              try {
                if (!response || typeof response.clone !== 'function') return;
                response
                  .clone()
                  .json()
                  .then((json) => {
                    try {
                      if (feedMeta) captureResponse(json, feedMeta);
                      else captureFilters(json);
                    } catch (e) {
                      /* образец необязателен */
                    }
                  })
                  .catch(() => {});
              } catch (e) {
                /* тело уже прочитано — просто нет образца */
              }
            })
            .catch(() => {});
        } catch (e) {
          /* промис нестандартный — не мешаем странице */
        }
      }

      return pending;
    };
  }
})();
