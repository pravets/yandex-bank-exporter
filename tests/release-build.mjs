// Проверка сборки релизного архива: версии, ссылки манифеста и содержимое ZIP.
// Сьют не требует zip/unzip: упаковка и чтение архива живут в самом скрипте сборки.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SRC_DIR,
  buildExtension,
  checkManifest,
  collectFiles,
  normalizeVersion,
  referencedFiles,
} from '../scripts/build-extension.mjs';

const manifest = JSON.parse(readFileSync(join(SRC_DIR, 'manifest.json'), 'utf8'));

// ---------- версии ----------
assert.deepEqual(normalizeVersion('v1.3.0'), { version: '1.3.0', prerelease: null });
assert.deepEqual(normalizeVersion('1.3.0'), { version: '1.3.0', prerelease: null });
assert.deepEqual(normalizeVersion('v1.4.0-beta.1'), { version: '1.4.0', prerelease: 'beta.1' });
assert.deepEqual(normalizeVersion('v2').version, '2');
assert.throws(() => normalizeVersion(''), /не задана/);
assert.throws(() => normalizeVersion('v1.3.0.0.0'), /от 1 до 4/);
assert.throws(() => normalizeVersion('v1.3.0.70000'), /больше 65535/);
assert.throws(() => normalizeVersion('v1.3.x'), /должен быть числом/);

// ---------- манифест ----------
assert.deepEqual(checkManifest(manifest, 'v' + manifest.version), []);
assert.deepEqual(checkManifest(manifest, manifest.version), []);
const mismatch = checkManifest(manifest, 'v9.9.9');
assert.equal(mismatch.length, 1);
assert.match(mismatch[0], /не совпадает с тегом 9\.9\.9/);
assert.ok(checkManifest({ ...manifest, manifest_version: 2 }, manifest.version).some((m) => /manifest_version/.test(m)));
assert.ok(checkManifest({ ...manifest, version: '' }, '1.3.0').some((m) => /version/.test(m)));
assert.ok(checkManifest(null, '1.3.0').length === 1);

// ---------- ссылки манифеста ----------
const referenced = referencedFiles(manifest);
for (const rel of ['popup.html', 'content.js', 'lib/deep-paths.js', 'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png']) {
  assert.ok(referenced.includes(rel), 'манифест должен ссылаться на ' + rel);
}
for (const rel of referenced) assert.ok(existsSync(join(SRC_DIR, rel)), 'нет файла ' + rel);

// ---------- сборка ----------
const outDir = mkdtempSync(join(tmpdir(), 'ypz-release-'));
const built = buildExtension({ version: manifest.version, outDir });
const archiveName = 'yandex-pay-export-' + manifest.version + '.zip';
assert.equal(built.file, join(outDir, archiveName));
assert.ok(existsSync(built.file));
assert.equal(built.entries.filter((name) => name === 'manifest.json').length, 1);
assert.ok(!built.entries.includes('README.md'));
assert.ok(!built.entries.some((name) => name.startsWith('src/')));
assert.deepEqual(built.entries, collectFiles(SRC_DIR));

// Повторная сборка обязана дать тот же байтовый результат: SHA256 стабилен.
const second = buildExtension({ version: manifest.version, outDir });
assert.ok(readFileSync(second.file).equals(readFileSync(built.file)), 'архив должен быть детерминированным');

console.log(
  JSON.stringify(
    {
      suite: 'release-build.mjs',
      version: manifest.version,
      file: built.file,
      entries: built.entries.length,
      bytes: built.bytes,
    },
    null,
    2,
  ),
);
