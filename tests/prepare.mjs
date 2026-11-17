// Свежесть снимка в prepare: только capture текущей загрузки и после команды reload.
import assert from 'node:assert/strict';

import { loadPopup } from './load-popup.mjs';

loadPopup();
const g = globalThis;

const t0 = 1000;

// --- снимок прошлой загрузки: тот же документ, но сделан до reload ---
assert.equal(
  g.isFreshCapture({ body: '{}', at: 500, pageTimeOrigin: 100 }, t0, 100),
  false,
  'старый по времени снимок не принимается',
);

// --- снимок сделан после reload, но остался в старом документе ---
assert.equal(
  g.isFreshCapture({ body: '{}', at: 1500, pageTimeOrigin: 100 }, t0, 200),
  false,
  'поздний ответ старого документа не принимается',
);

// --- свежая загрузка: время после reload и совпадающий origin ---
assert.equal(
  g.isFreshCapture({ body: '{}', at: 1500, pageTimeOrigin: 200 }, t0, 200),
  true,
);

// --- граница: ровно момент команды считается свежим ---
assert.equal(g.isFreshCapture({ body: '{}', at: t0, pageTimeOrigin: 200 }, t0, 200), true);

// --- без тела запроса снимок не годится ---
assert.equal(g.isFreshCapture({ body: null, at: 1500, pageTimeOrigin: 200 }, t0, 200), false);

// --- нет origin (старый content script или закрытая вкладка) ---
assert.equal(g.isFreshCapture({ body: '{}', at: 1500 }, t0, 200), false, 'нет origin снимка');
assert.equal(g.isFreshCapture({ body: '{}', at: 1500, pageTimeOrigin: 200 }, t0, null), false, 'нет origin вкладки');

console.log('prepare: OK');
