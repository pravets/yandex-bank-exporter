/**
 * xlsx-lite — крошечный генератор .xlsx без зависимостей.
 *
 * ZIP собирается методом STORE (без сжатия), OOXML пишется вручную:
 * этого достаточно для таблицы на несколько тысяч строк, а вес библиотеки — нулевой.
 *
 * API:
 *   XlsxLite.build([{ name, rows, widths, freeze, autoFilter }]) -> Uint8Array
 *   ячейка: null | { v, s } | примитив (число/строка)
 *   XlsxLite.dateSerial(y, m, d, hh, mm) -> число для ячейки с форматом даты
 *   XlsxLite.timeFraction(hh, mm) -> доля суток для формата HH:MM
 */
(function (root) {
  'use strict';

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

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const encoder = new TextEncoder();
  const le16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
  const le32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

  function zipStore(entries) {
    const parts = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.name);
      const data = entry.data;
      const crc = crc32(data);

      const localHeader = new Uint8Array(
        [].concat(
          le32(0x04034b50),
          le16(20),
          le16(0x0800), // UTF-8 имена
          le16(0), // метод: STORE
          le16(0),
          le16(0), // время/дата
          le32(crc),
          le32(data.length),
          le32(data.length),
          le16(nameBytes.length),
          le16(0),
        ),
      );

      parts.push(localHeader, nameBytes, data);
      central.push(
        new Uint8Array(
          [].concat(
            le32(0x02014b50),
            le16(20),
            le16(20),
            le16(0x0800),
            le16(0),
            le16(0),
            le16(0),
            le32(crc),
            le32(data.length),
            le32(data.length),
            le16(nameBytes.length),
            le16(0),
            le16(0),
            le16(0),
            le16(0),
            le32(0),
            le32(offset),
          ),
        ),
        nameBytes,
      );

      offset += localHeader.length + nameBytes.length + data.length;
    }

    let centralSize = 0;
    for (const chunk of central) centralSize += chunk.length;

    const eocd = new Uint8Array(
      [].concat(
        le32(0x06054b50),
        le16(0),
        le16(0),
        le16(entries.length),
        le16(entries.length),
        le32(centralSize),
        le32(offset),
        le16(0),
      ),
    );

    const all = parts.concat(central, [eocd]);
    let total = 0;
    for (const chunk of all) total += chunk.length;

    const out = new Uint8Array(total);
    let pos = 0;
    for (const chunk of all) {
      out.set(chunk, pos);
      pos += chunk.length;
    }
    return out;
  }

  // ---------- OOXML ----------
  /**
   * Удаляет кодовые точки, недопустимые в XML 1.0: управляющие (кроме TAB/LF/CR),
   * одиночные суррогаты и noncharacters (U+FDD0–U+FDEF, U+xxFFFE/U+xxFFFF).
   * Без этого Excel не открывает книгу: парсер падает на `not well-formed`.
   */
  function stripInvalidXml(text) {
    let out = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp === 0x9 || cp === 0xa || cp === 0xd) {
        out += ch;
        continue;
      }
      if (cp < 0x20) continue;
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // одиночный суррогат
      if (cp >= 0xfdd0 && cp <= 0xfdef) continue;
      if ((cp & 0xffff) === 0xfffe || (cp & 0xffff) === 0xffff) continue;
      out += ch;
    }
    return out;
  }

  function esc(value) {
    return stripInvalidXml(String(value))
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function colName(index) {
    let n = index;
    let name = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      name = String.fromCharCode(65 + rem) + name;
      n = Math.floor((n - 1) / 26);
    }
    return name;
  }

  const NUM_FORMATS = [
    { id: 164, code: 'DD.MM.YYYY' },
    { id: 165, code: 'HH:MM' },
    { id: 166, code: '#,##0.00' },
    { id: 167, code: '0.0%' },
  ];

  const FONTS = [
    '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>',
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>',
    '<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>',
    '<font><b/><sz val="15"/><color rgb="FF1F2430"/><name val="Calibri"/><family val="2"/></font>',
    '<font><i/><sz val="10"/><color rgb="FF6B7280"/><name val="Calibri"/><family val="2"/></font>',
  ];

  const FILLS = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FF2B3A55"/><bgColor indexed="64"/></patternFill></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF4F6FA"/><bgColor indexed="64"/></patternFill></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF4E5"/><bgColor indexed="64"/></patternFill></fill>',
  ];

  const BORDERS = [
    '<border><left/><right/><top/><bottom/><diagonal/></border>',
    '<border><left style="thin"><color rgb="FFDCE1EA"/></left><right style="thin"><color rgb="FFDCE1EA"/></right>' +
      '<top style="thin"><color rgb="FFDCE1EA"/></top><bottom style="thin"><color rgb="FFDCE1EA"/></bottom><diagonal/></border>',
  ];

  // font / fill / border / numFmt / alignment
  const XFS = [
    { f: 0, fl: 0, b: 0, n: 0 }, // 0 обычный
    { f: 1, fl: 2, b: 0, n: 0, h: 'center', v: 'center', wrap: 1 }, // 1 шапка
    { f: 0, fl: 0, b: 1, n: 164, h: 'center' }, // 2 дата
    { f: 0, fl: 0, b: 1, n: 165, h: 'center' }, // 3 время
    { f: 0, fl: 0, b: 1, n: 166, h: 'right' }, // 4 деньги
    { f: 0, fl: 0, b: 1, n: 0 }, // 5 текст
    { f: 0, fl: 0, b: 1, n: 0, h: 'center' }, // 6 по центру
    { f: 2, fl: 0, b: 1, n: 0 }, // 7 жирный текст
    { f: 2, fl: 0, b: 1, n: 166, h: 'right' }, // 8 жирные деньги
    { f: 3, fl: 0, b: 0, n: 0 }, // 9 заголовок
    { f: 4, fl: 0, b: 0, n: 0 }, // 10 приглушённый
    { f: 2, fl: 4, b: 1, n: 0 }, // 11 итог: подпись
    { f: 2, fl: 4, b: 1, n: 166, h: 'right' }, // 12 итог: деньги
    { f: 0, fl: 0, b: 1, n: 167, h: 'right' }, // 13 проценты
    { f: 0, fl: 3, b: 1, n: 0 }, // 14 зебра: текст
    { f: 0, fl: 3, b: 1, n: 166, h: 'right' }, // 15 зебра: деньги
    { f: 0, fl: 3, b: 1, n: 164, h: 'center' }, // 16 зебра: дата
    { f: 0, fl: 3, b: 1, n: 165, h: 'center' }, // 17 зебра: время
    { f: 0, fl: 3, b: 1, n: 0, h: 'center' }, // 18 зебра: по центру
    { f: 2, fl: 0, b: 0, n: 166, h: 'right' }, // 19 жирные деньги без рамки
    { f: 1, fl: 2, b: 1, n: 0 }, // 20 шапка с рамкой (слева)
    { f: 0, fl: 0, b: 1, n: 0, h: 'right' }, // 21 число справа
  ];

  const STYLE = {
    DEFAULT: 0,
    HEADER: 1,
    DATE: 2,
    TIME: 3,
    MONEY: 4,
    TEXT: 5,
    CENTER: 6,
    BOLD: 7,
    BOLD_MONEY: 8,
    TITLE: 9,
    MUTED: 10,
    TOTAL_LABEL: 11,
    TOTAL_MONEY: 12,
    PERCENT: 13,
    ZEBRA_TEXT: 14,
    ZEBRA_MONEY: 15,
    ZEBRA_DATE: 16,
    ZEBRA_TIME: 17,
    ZEBRA_CENTER: 18,
    BOLD_MONEY_PLAIN: 19,
    HEADER_BORDERED: 20,
    NUMBER_RIGHT: 21,
  };

  function xfXml(xf) {
    const attrs = [
      `numFmtId="${xf.n || 0}"`,
      `fontId="${xf.f || 0}"`,
      `fillId="${xf.fl || 0}"`,
      `borderId="${xf.b || 0}"`,
      'xfId="0"',
    ];
    if (xf.n) attrs.push('applyNumberFormat="1"');
    if (xf.f) attrs.push('applyFont="1"');
    if (xf.fl) attrs.push('applyFill="1"');
    if (xf.b) attrs.push('applyBorder="1"');
    if (xf.h || xf.v || xf.wrap) attrs.push('applyAlignment="1"');
    let inner = '';
    if (xf.h || xf.v || xf.wrap) {
      inner += '<alignment';
      if (xf.h) inner += ` horizontal="${xf.h}"`;
      if (xf.v) inner += ` vertical="${xf.v}"`;
      if (xf.wrap) inner += ' wrapText="1"';
      inner += '/>';
    }
    return `<xf ${attrs.join(' ')}>${inner}</xf>`;
  }

  function stylesXml() {
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<numFmts count="${NUM_FORMATS.length}">` +
      NUM_FORMATS.map((f) => `<numFmt numFmtId="${f.id}" formatCode="${esc(f.code)}"/>`).join('') +
      '</numFmts>' +
      `<fonts count="${FONTS.length}">${FONTS.join('')}</fonts>` +
      `<fills count="${FILLS.length}">${FILLS.join('')}</fills>` +
      `<borders count="${BORDERS.length}">${BORDERS.join('')}</borders>` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${XFS.length}">${XFS.map(xfXml).join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>'
    );
  }

  function cellXml(cell, ref) {
    if (cell === null || cell === undefined || cell === '') return '';
    const style = typeof cell === 'object' && cell !== null && !(cell instanceof Date) ? cell.s || 0 : 0;
    const value = typeof cell === 'object' && cell !== null && !(cell instanceof Date) ? cell.v : cell;
    if (value === null || value === undefined || value === '') return '';

    const s = style ? ` s="${style}"` : '';
    if (typeof value === 'number' && isFinite(value)) {
      return `<c r="${ref}"${s}><v>${value}</v></c>`;
    }
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
  }

  function sheetXml(sheet) {
    const rows = sheet.rows || [];
    const cols = sheet.widths || [];
    const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);

    const dimension =
      rows.length && maxCols
        ? `A1:${colName(maxCols)}${rows.length}`
        : 'A1';

    let colsXml = '';
    if (cols.length) {
      colsXml =
        '<cols>' +
        cols
          .map(
            (width, i) =>
              `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`,
          )
          .join('') +
        '</cols>';
    }

    let freezeXml = '';
    if (sheet.freeze && sheet.freeze.rows) {
      const rowsFrozen = sheet.freeze.rows;
      const colsFrozen = sheet.freeze.cols || 0;
      const topLeft = (colsFrozen ? colName(colsFrozen + 1) : 'A') + (rowsFrozen + 1);
      freezeXml = `<pane ${colsFrozen ? `xSplit="${colsFrozen}" ` : ''}ySplit="${rowsFrozen}" topLeftCell="${topLeft}" activePane="bottomRight" state="frozen"/>`;
    }

    const rowsXml = rows
      .map((row, rowIndex) => {
        const r = rowIndex + 1;
        const height = sheet.rowHeights && sheet.rowHeights[rowIndex];
        const cells = row
          .map((cell, colIndex) => cellXml(cell, colName(colIndex + 1) + r))
          .join('');
        if (!cells) return '';
        return `<row r="${r}"${height ? ` ht="${height}" customHeight="1"` : ''}>${cells}</row>`;
      })
      .join('');

    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<dimension ref="${dimension}"/>` +
      `<sheetViews><sheetView workbookViewId="0">${freezeXml}</sheetView></sheetViews>` +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      colsXml +
      `<sheetData>${rowsXml}</sheetData>` +
      (sheet.autoFilter ? `<autoFilter ref="${sheet.autoFilter}"/>` : '') +
      '</worksheet>'
    );
  }

  function build(sheets) {
    const files = [];

    const contentTypes =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>';

    files.push({ name: '[Content_Types].xml', data: encoder.encode(contentTypes) });
    files.push({
      name: '_rels/.rels',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
      ),
    });

    files.push({
      name: 'xl/workbook.xml',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets>' +
          sheets
            .map(
              (sheet, i) =>
                `<sheet name="${esc(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
            )
            .join('') +
          '</sheets>' +
          '</workbook>',
      ),
    });

    files.push({
      name: 'xl/_rels/workbook.xml.rels',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          sheets
            .map(
              (_, i) =>
                `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
            )
            .join('') +
          `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
          '</Relationships>',
      ),
    });

    files.push({ name: 'xl/styles.xml', data: encoder.encode(stylesXml()) });

    sheets.forEach((sheet, i) => {
      files.push({
        name: `xl/worksheets/sheet${i + 1}.xml`,
        data: encoder.encode(sheetXml(sheet)),
      });
    });

    return zipStore(files);
  }

  // Excel считает дни от 1899-12-30 (с поправкой на «високосный» 1900 год).
  function dateSerial(year, month, day, hours, minutes) {
    const utc = Date.UTC(year, month - 1, day);
    const base = Date.UTC(1899, 11, 30);
    const days = Math.round((utc - base) / 86400000);
    return days + ((hours || 0) * 60 + (minutes || 0)) / 1440;
  }

  function timeFraction(hours, minutes) {
    return ((hours || 0) * 60 + (minutes || 0)) / 1440;
  }

  root.XlsxLite = { build, dateSerial, timeFraction, STYLE };
})(typeof globalThis !== 'undefined' ? globalThis : this);
