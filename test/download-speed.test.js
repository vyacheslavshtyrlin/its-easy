"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const http = require("node:http");
const { once } = require("node:events");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { promisify } = require("node:util");

const {
  download,
  formatResults,
  measureDownloads,
  parseUrl
} = require("../download-speed");

let server;
let baseUrl;
let requestCount;
let activeRequests;
let maxActiveRequests;
const execFileAsync = promisify(execFile);

before(async () => {
  server = http.createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/data" });
      response.end();
      return;
    }

    if (request.url === "/error") {
      response.writeHead(503);
      response.end("unavailable");
      return;
    }

    if (request.url === "/invalid-redirect") {
      response.writeHead(302, { location: "http://[invalid" });
      response.end();
      return;
    }

    if (request.url === "/aborted-redirect") {
      response.writeHead(302, { location: "/data" });
      response.write("partial");
      response.socket.destroy();
      return;
    }

    if (request.url === "/slow") {
      response.writeHead(200);
      const interval = setInterval(() => response.write("x"), 5);
      response.once("close", () => clearInterval(interval));
      return;
    }

    requestCount += 1;
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);

    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.alloc(1024));
      activeRequests -= 1;
    }, 5);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server.close();
  await once(server, "close");
});

test("валидирует URL и протокол", () => {
  assert.equal(parseUrl("https://example.com/image.jpg").protocol, "https:");
  assert.throws(() => parseUrl(), /Укажите URL/);
  assert.throws(() => parseUrl("not a url"), /Некорректный URL/);
  assert.throws(() => parseUrl("ftp://example.com/file"), /только протоколы/);
});

test("делает 10 запросов строго последовательно и считает байты", async () => {
  requestCount = 0;
  activeRequests = 0;
  maxActiveRequests = 0;

  const result = await measureDownloads(new URL(`${baseUrl}/data`));

  assert.equal(requestCount, 10);
  assert.equal(maxActiveRequests, 1);
  assert.equal(result.totalBytes, 10 * 1024);
  assert.equal(result.requests.length, 10);
  assert.ok(result.averageDurationMs > 0);
  assert.ok(result.speedMiBPerSecond > 0);
});

test("следует по редиректу", async () => {
  const bytes = await download(new URL(`${baseUrl}/redirect`));
  assert.equal(bytes, 1024);
});

test("отклоняет HTTP-ошибку после чтения ответа", async () => {
  await assert.rejects(
    download(new URL(`${baseUrl}/error`)),
    /HTTP-статусом 503/
  );
});

test("ограничивает число редиректов", async () => {
  await assert.rejects(
    download(new URL(`${baseUrl}/redirect`), { maxRedirects: 0 }),
    /лимит редиректов/
  );
});

test("отклоняет некорректный адрес редиректа", async () => {
  await assert.rejects(
    download(new URL(`${baseUrl}/invalid-redirect`)),
    /Некорректный адрес редиректа/
  );
});

test("обрабатывает разрыв соединения во время редиректа", async () => {
  await assert.rejects(
    download(new URL(`${baseUrl}/aborted-redirect`)),
    /разорвано|socket hang up/
  );
});

test("ограничивает полное время ответа, даже если данные продолжают поступать", async () => {
  const startedAt = performance.now();

  await assert.rejects(
    download(new URL(`${baseUrl}/slow`), { timeoutMs: 30 }),
    /Таймаут запроса/
  );

  assert.ok(performance.now() - startedAt < 500);
});

test("валидирует программные настройки", async () => {
  await assert.rejects(
    measureDownloads(new URL(`${baseUrl}/data`), { requestCount: 0 }),
    /Количество запросов/
  );
  await assert.rejects(
    download(new URL(`${baseUrl}/data`), { timeoutMs: 0 }),
    /Таймаут/
  );
  await assert.rejects(
    download(new URL(`${baseUrl}/data`), { maxRedirects: -1 }),
    /Лимит редиректов/
  );
});

test("точно рассчитывает среднее время и скорость", async () => {
  const timestamps = [0, 100, 100, 300];
  const result = await measureDownloads(new URL(`${baseUrl}/data`), {
    requestCount: 2,
    now: () => timestamps.shift()
  });

  assert.equal(result.totalBytes, 2 * 1024);
  assert.equal(result.totalDurationMs, 300);
  assert.equal(result.averageDurationMs, 150);
  assert.equal(
    result.speedMiBPerSecond,
    (2 * 1024 / (1024 * 1024)) / 0.3
  );
});

test("форматирует единицы измерения", () => {
  const output = formatResults({
    requestCount: 10,
    averageDurationMs: 100,
    totalBytes: 1024 * 1024,
    speedMiBPerSecond: 1
  });

  assert.match(output, /100\.00 мс/);
  assert.match(output, /1\.00 MiB/);
  assert.match(output, /1\.00 MiB\/s/);
});

test("CLI завершается с ошибкой при запуске без URL", async () => {
  const scriptPath = path.resolve(__dirname, "../download-speed.js");

  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath]),
    (error) => error.code === 1 && /Укажите URL/.test(error.stderr)
  );
});
