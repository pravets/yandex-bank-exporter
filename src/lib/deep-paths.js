/**
 * Сбор путей полей вложенного объекта: `account.title`, `items[].card.mask`.
 *
 * Один модуль для content script (MAIN world) и попапа: оба подключают его
 * обычным <script>/content_scripts, поэтому зависимостей и экспортов нет —
 * только глобальный `DeepPaths`.
 *
 * Использование: DeepPaths.paths([объект, ...]) -> отсортированный массив строк.
 */
(function (root) {
  'use strict';

  const MAX_DEPTH = 4;

  function walk(value, prefix, depth, paths) {
    if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return;
    if (Array.isArray(value)) {
      if (value.length) walk(value[0], prefix + '[]', depth + 1, paths);
      return;
    }
    for (const key of Object.keys(value)) {
      const path = prefix ? prefix + '.' + key : key;
      paths.add(path);
      walk(value[key], path, depth + 1, paths);
    }
  }

  /** Пути всех полей набора объектов, без префикса на верхнем уровне. */
  function paths(items) {
    const found = new Set();
    for (const item of items || []) walk(item, '', 0, found);
    return [...found].sort();
  }

  root.DeepPaths = { paths };
})(typeof globalThis !== 'undefined' ? globalThis : this);
