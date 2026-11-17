// content.js в отдельном VM-контексте: чужие ответы не разбираются,
// целевые перехватываются, поддерживаются формы Request/URL.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'src', 'content.js'), 'utf8');
const deepPaths = readFileSync(join(here, '..', 'src', 'lib', 'deep-paths.js'), 'utf8');

function makePage() {
  const calls = { clone: 0, json: 0 };
  const sandbox = {
    console,
    JSON,
    Object,
    Array,
    Math,
    Number,
    String,
    Boolean,
    Set,
    Map,
    Promise,
    Date,
    Error,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    decodeURIComponent,
  };
  sandbox.window = sandbox;
  sandbox.location = { search: '' };
  sandbox.performance = { timeOrigin: 4242 };
  sandbox.fetch = function () {
    const response = {
      ok: true,
      json: async () => {
        calls.json += 1;
        return { data: {} };
      },
      clone() {
        calls.clone += 1;
        return { json: response.json };
      },
    };
    return Promise.resolve(response);
  };
  vm.createContext(sandbox);
  vm.runInContext(deepPaths, sandbox, { filename: 'deep-paths.js' });
  vm.runInContext(source, sandbox, { filename: 'content.js' });
  return { sandbox, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- 1. нецелевой запрос: тело ответа не читается ---
{
  const { sandbox, calls } = makePage();
  await sandbox.fetch('/assets/config.json', { method: 'GET' });
  await flush();
  assert.equal(calls.clone, 0, 'clone() не вызывается для чужого ответа');
  assert.equal(calls.json, 0, 'json() не вызывается для чужого ответа');
}

// --- 2. целевой запрос перехватывается и разбирается ---
{
  const { sandbox, calls } = makePage();
  const body = JSON.stringify({
    operationName: 'GetTransactionFeedView',
    variables: { agreementId: 'pa_X', filterType: 'PAY_CARD', size: 50 },
    extensions: { persistedQuery: { sha256Hash: 'hash' } },
  });
  await sandbox.fetch('/graphql?operationId=hash', {
    method: 'POST',
    body,
  });
  await flush();

  const capture = sandbox.window.__yandexPayExportCapture;
  assert.equal(capture.body, body);
  assert.equal(capture.agreementId, 'pa_X');
  assert.equal(capture.filterType, 'PAY_CARD');
  assert.equal(capture.pageTimeOrigin, 4242, 'origin документа записан для prepare');
  assert.equal(calls.clone, 1);
  assert.equal(calls.json, 1);
  assert.equal(capture.operations[0].operationName, 'GetTransactionFeedView');
  assert.equal(capture.operations[0].responseSkipped, undefined);
}

// --- 3. прочие GraphQL-операции: журнал без тела ответа ---
{
  const { sandbox, calls } = makePage();
  const body = JSON.stringify({ operationName: 'GetSomethingElse', variables: {} });
  await sandbox.fetch('/graphql', { method: 'POST', body });
  await flush();

  const capture = sandbox.window.__yandexPayExportCapture;
  assert.equal(capture.operations[0].operationName, 'GetSomethingElse');
  assert.equal(capture.operations[0].responseSkipped, true);
  assert.equal(calls.clone, 0, 'ответ нецелевой операции не клонируется');
}

// --- 4. форма Request: URL и метод берутся из объекта ---
{
  const { sandbox } = makePage();
  const body = JSON.stringify({
    operationName: 'GetTransactionFeedView',
    variables: { agreementId: 'pa_REQ' },
  });
  await sandbox.fetch({ url: '/graphql', method: 'POST' }, { body });
  await flush();

  const capture = sandbox.window.__yandexPayExportCapture;
  assert.equal(capture.body, body, 'перехват работает для fetch(Request, init)');
  assert.equal(capture.agreementId, 'pa_REQ');
}

// --- 5. форма URL: href вместо строки ---
{
  const { sandbox } = makePage();
  const body = JSON.stringify({
    operationName: 'GetTransactionFeedView',
    variables: { agreementId: 'pa_URL' },
  });
  await sandbox.fetch({ href: '/graphql' }, { method: 'POST', body });
  await flush();

  assert.equal(sandbox.window.__yandexPayExportCapture.agreementId, 'pa_URL');
}

// --- 6. нестроковое тело: не разбираем, но считаем ---
{
  const { sandbox, calls } = makePage();
  await sandbox.fetch('/graphql', { method: 'POST', body: { not: 'a string' } });
  await flush();

  const capture = sandbox.window.__yandexPayExportCapture;
  assert.equal(capture.unsupportedForms, 1);
  assert.equal(capture.body, null);
  assert.equal(calls.clone, 0);
}

console.log('content: OK');
