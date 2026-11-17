// Блокировка берётся синхронно: второй вход не проходит, пока первый не отпустит.
import assert from 'node:assert/strict';

import { loadPopup } from './load-popup.mjs';

function node() {
  return {
    disabled: false,
    hidden: false,
    textContent: '',
    checked: false,
    value: '',
    dataset: {},
    style: {},
    classList: { add() {}, remove() {} },
    addEventListener() {},
  };
}

const nodes = new Map();
loadPopup({
  getElementById: (id) => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  },
});

const g = globalThis;

// Первый вход занимает блокировку, второй синхронный вход — уже нет.
assert.equal(g.tryBeginBusy(), true, 'первый вход получает блокировку');
assert.equal(g.tryBeginBusy(), false, 'второй вход отклонён без ожиданий');

const run = nodes.get('run');
assert.equal(run.disabled, true, 'кнопки заблокированы сразу, до первого await');

// Освобождение возвращает возможность запуска.
g.setBusy(false);
assert.equal(run.disabled, false);
assert.equal(g.tryBeginBusy(), true, 'после освобождения блокировка снова берётся');
g.setBusy(false);

console.log('busy: OK');
