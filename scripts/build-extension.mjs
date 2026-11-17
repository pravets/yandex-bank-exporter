#!/usr/bin/env node
/**
 * Сборка релизного ZIP расширения без внешних зависимостей.
 *
 * Использование:
 *   node scripts/build-extension.mjs [--version vX.Y.Z] [--out dist] [--help]
 *
 * Что делает:
 *   1. проверяет формат версии (1-4 числа, каждое до 65535) и совпадение
 *      с src/manifest.json — расхождение это ошибка, а не предупреждение;
 *   2. проверяет, что все файлы, на которые ссылается манифест, существуют;
 *   3. пакует src/ (без README.md и служебного мусора) в STORE-ZIP;
 *   4. перечитывает архив и сверяет имена записей, размеры и CRC32.
 *
 * ZIP пишется вручную, потому что в репозитории нет зависимостей, а zip/unzip
 * есть не на каждой машине. Дата записей фиксирована (1980-01-01), поэтому
 * архив детерминирован: одинаковое содержимое даёт одинаковый SHA256.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
export const SRC_DIR = join(REPO_ROOT, 'src');

const EXCLUDED_NAMES = new Set(['README.md', '.DS_Store', 'Thumbs.db', '__MACOSX']);

const USAGE = [
  'Сборка релизного ZIP расширения',
  '',
  '  node scripts/build-extension.mjs [--version vX.Y.Z] [--out dist]',
  '',
  '  --version  ожидаемая версия (обычно имя тега); без флага берётся из манифеста',
  '  --out      каталог для архива, по умолчанию dist',
  '  --help     эта справка',
].join('\n');

// ---------- ZIP (STORE) ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 1 января 1980, 00:00:00 — минимальная дата DOS, поэтому архив детерминирован.
const ZIP_DOS_DATE = (1 << 5) | 1;

function createZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const localOffset = offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // нужная версия
    local.writeUInt16LE(0x0800, 6); // имена в UTF-8
    local.writeUInt16LE(0, 8); // метод: STORE
    local.writeUInt16LE(0, 10); // время
    local.writeUInt16LE(ZIP_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(ZIP_DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(entry.data.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(localOffset, 42);

    parts.push(local, nameBytes, entry.data);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + entry.data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, centralBuffer, eocd]);
}

export function readZipEntries(buffer) {
  let eocd = -1;
  const stop = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= stop; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('в архиве нет EOCD-записи');

  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('битая центральная директория архива');
    }
    const crc = buffer.readUInt32LE(cursor + 16);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({ name, crc, size, data: buffer.subarray(dataStart, dataStart + size) });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  if (cursor - centralOffset !== centralSize) {
    throw new Error('размер центральной директории архива не совпал');
  }
  return entries;
}

// ---------- версия и манифест ----------
export function normalizeVersion(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('версия не задана');
  let raw = input.trim();
  if (raw.startsWith('v') || raw.startsWith('V')) raw = raw.slice(1);

  const dash = raw.indexOf('-');
  const base = dash === -1 ? raw : raw.slice(0, dash);
  const prerelease = dash === -1 ? null : raw.slice(dash + 1);

  if (prerelease !== null && !/^[0-9A-Za-z.-]+$/.test(prerelease)) {
    throw new Error('версия "' + input + '": недопустимый суффикс предрелиза "' + prerelease + '"');
  }

  const parts = base.split('.');
  if (parts.length < 1 || parts.length > 4) {
    throw new Error('версия "' + input + '": Chrome принимает от 1 до 4 числовых компонентов');
  }
  for (const part of parts) {
    if (!/^\d{1,5}$/.test(part)) {
      throw new Error('версия "' + input + '": компонент "' + part + '" должен быть числом');
    }
    if (Number(part) > 65535) {
      throw new Error('версия "' + input + '": компонент ' + part + ' больше 65535');
    }
  }
  return { version: parts.join('.'), prerelease };
}

export function checkManifest(manifest, expectedVersion) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['manifest.json не разобран как объект'];
  }
  if (manifest.manifest_version !== 3) {
    errors.push('manifest_version должен быть 3, а не ' + JSON.stringify(manifest.manifest_version));
  }

  const version = typeof manifest.version === 'string' ? manifest.version : '';
  if (!version) {
    errors.push('в манифесте нет строкового поля version');
  } else {
    try {
      normalizeVersion(version);
    } catch (error) {
      errors.push('version в манифесте: ' + error.message);
    }
  }

  if (version && expectedVersion) {
    try {
      const actual = normalizeVersion(version);
      const expected = normalizeVersion(expectedVersion);
      if (actual.version !== expected.version) {
        errors.push(
          'версия манифеста ' + actual.version + ' не совпадает с тегом ' + expected.version +
            ': поднимите version в src/manifest.json или выпустите тег с правильной версией',
        );
      }
    } catch (error) {
      errors.push('тег: ' + error.message);
    }
  }
  return errors;
}

export function referencedFiles(manifest) {
  const files = new Set();
  const add = (value) => {
    if (typeof value !== 'string' || !value) return;
    // Шаблоны (web_accessible_resources) не проверяем поштучно: их раскрытие
    // зависит от наличия файлов и не является обязательным для загрузки.
    if (value.includes('*') || value.includes('?')) return;
    files.add(value.replace(/^\.\//, ''));
  };
  const addIconSet = (set) => {
    if (typeof set === 'string') add(set);
    else if (set && typeof set === 'object') for (const value of Object.values(set)) add(value);
  };

  add(manifest.action?.default_popup);
  addIconSet(manifest.action?.default_icon);
  addIconSet(manifest.icons);
  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) add(file);
    for (const file of script.css || []) add(file);
  }
  if (manifest.background) {
    add(manifest.background.service_worker);
    for (const file of manifest.background.scripts || []) add(file);
    add(manifest.background.page);
  }
  add(manifest.options_page);
  add(manifest.options_ui?.page);
  add(manifest.devtools_page);
  add(manifest.side_panel?.default_path);
  for (const entry of manifest.web_accessible_resources || []) {
    if (typeof entry === 'string') add(entry);
    else for (const resource of entry?.resources || []) add(resource);
  }
  for (const ruleSet of manifest.declarative_net_request?.rule_resources || []) add(ruleSet?.path);
  return [...files].sort();
}

// ---------- сборка ----------
export function collectFiles(srcDir = SRC_DIR) {
  const files = [];
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (EXCLUDED_NAMES.has(entry.name)) continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(relative(srcDir, absolute).split(sep).join('/'));
    }
  };
  walk(srcDir);
  files.sort();
  return files;
}

function verifyArchive(readBack, entries) {
  const names = readBack.map((entry) => entry.name);
  if (!names.includes('manifest.json')) throw new Error('в архиве нет manifest.json в корне');
  if (names.some((name) => name.startsWith('src/'))) throw new Error('в архиве остался префикс src/');
  if (names.some((name) => name === 'README.md')) throw new Error('в архиве оказался README.md');

  const expected = entries.map((entry) => entry.name);
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error('набор файлов архива не совпал с src/: ' + names.join(', '));
  }
  for (let index = 0; index < entries.length; index++) {
    const packed = readBack[index];
    const source = entries[index];
    if (packed.size !== source.data.length) throw new Error('размер записи не совпал: ' + packed.name);
    if (packed.crc !== crc32(source.data)) throw new Error('CRC записи не совпал: ' + packed.name);
    if (!packed.data.equals(source.data)) throw new Error('данные записи не совпали: ' + packed.name);
  }
}

export function buildExtension({ version, outDir = 'dist', srcDir = SRC_DIR } = {}) {
  const normalized = normalizeVersion(version).version;
  if (!existsSync(join(srcDir, 'manifest.json'))) {
    throw new Error('не найден ' + join(srcDir, 'manifest.json'));
  }

  const files = collectFiles(srcDir);
  if (!files.includes('manifest.json')) throw new Error('в src/ нет manifest.json');

  const entries = files.map((name) => ({ name, data: readFileSync(join(srcDir, name)) }));
  const archive = createZip(entries);

  const targetDir = resolve(outDir);
  mkdirSync(targetDir, { recursive: true });
  const file = join(targetDir, 'yandex-pay-export-' + normalized + '.zip');
  writeFileSync(file, archive);

  verifyArchive(readZipEntries(readFileSync(file)), entries);
  return { version: normalized, file, bytes: statSync(file).size, entries: files };
}

export function parseArgs(argv) {
  const options = { version: undefined, out: 'dist', help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--version' || arg === '-v') {
      options.version = argv[++index];
      if (!options.version) throw new Error('--version требует значение');
    } else if (arg.startsWith('--version=')) {
      options.version = arg.slice('--version='.length);
    } else if (arg === '--out' || arg === '-o') {
      options.out = argv[++index];
      if (!options.out) throw new Error('--out требует значение');
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length);
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error('неизвестный аргумент: ' + arg);
    }
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) return { help: USAGE };

  const manifest = JSON.parse(readFileSync(join(SRC_DIR, 'manifest.json'), 'utf8'));
  const expected = options.version || manifest.version;
  const errors = checkManifest(manifest, expected);
  if (errors.length) throw new Error(errors.join('; '));

  const missing = referencedFiles(manifest).filter((rel) => !existsSync(join(SRC_DIR, rel)));
  if (missing.length) {
    throw new Error('манифест ссылается на отсутствующие файлы: ' + missing.join(', '));
  }

  const { version } = normalizeVersion(expected);
  return buildExtension({ version, outDir: options.out });
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(USAGE);
    else console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error('Ошибка сборки: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
