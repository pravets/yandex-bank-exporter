// Загружает src/lib/xlsx-lite.js и src/popup.js в текущий процесс через vm.
// Хвост с document.addEventListener('DOMContentLoaded', init) отрезаем: в тестах
// init() не нужен и тянет за собой DOM/chrome.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, '..', 'src');

export function loadPopup({ getElementById = () => null } = {}) {
  const popupSource = readFileSync(join(ext, 'popup.js'), 'utf8');
  const cut = popupSource.indexOf("document.addEventListener('DOMContentLoaded', init);");
  if (cut === -1) throw new Error('не нашёл точку входа popup.js');

  globalThis.document = { addEventListener() {}, readyState: 'loading', getElementById };

  vm.runInThisContext(readFileSync(join(ext, 'lib', 'xlsx-lite.js'), 'utf8'), {
    filename: 'xlsx-lite.js',
  });
  vm.runInThisContext(readFileSync(join(ext, 'lib', 'deep-paths.js'), 'utf8'), {
    filename: 'deep-paths.js',
  });
  vm.runInThisContext(popupSource.slice(0, cut), { filename: 'popup.js' });

  return globalThis;
}
