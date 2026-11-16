#!/usr/bin/env node

"use strict";

const http = require("node:http");
const https = require("node:https");
const { performance } = require("node:perf_hooks");

const REQUEST_COUNT = 10;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const BYTES_PER_MEBIBYTE = 1024 * 1024;
const REQUEST_HEADERS = {
  "accept-encoding": "identity",
  "user-agent": "download-speed-cli/1.0"
};

function parseUrl(value) {
  if (!value) {
    throw new Error("Укажите URL первым аргументом командной строки.");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Некорректный URL: ${value}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Поддерживаются только протоколы http: и https:.");
  }

  return url;
}

function validateDownloadOptions(timeoutMs, maxRedirects) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Таймаут должен быть положительным числом.");
  }
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new Error("Лимит редиректов должен быть неотрицательным целым числом.");
  }
}

function parseRedirectUrl(location, currentUrl) {
  let nextUrl;
  try {
    nextUrl = new URL(location, currentUrl);
  } catch {
    throw new Error(`Некорректный адрес редиректа: ${location}`);
  }

  if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
    throw new Error(`Редирект на неподдерживаемый протокол: ${nextUrl.protocol}`);
  }

  return nextUrl;
}

function performRequest(url, remainingTimeoutMs, configuredTimeoutMs) {
  const client = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    let completed = false;
    let timer;

    const complete = (callback, value) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      callback(value);
    };
    const resolveOnce = (value) => complete(resolve, value);
    const rejectOnce = (error) => complete(reject, error);

    const request = client.get(url, { headers: REQUEST_HEADERS }, (response) => {
      if (completed) {
        response.destroy();
        return;
      }

      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
      });
      response.once("end", () => {
        resolveOnce({
          bytes,
          location: response.headers.location,
          statusCode: response.statusCode ?? 0
        });
      });
      response.once("error", rejectOnce);
      response.once("aborted", () => {
        rejectOnce(new Error("Соединение разорвано до полного получения ответа."));
      });
    });

    timer = setTimeout(() => {
      const error = new Error(`Таймаут запроса (${configuredTimeoutMs} мс).`);
      request.destroy(error);
      rejectOnce(error);
    }, remainingTimeoutMs);
    request.once("error", rejectOnce);
  });
}

function isRedirect(statusCode, location) {
  return statusCode >= 300 && statusCode < 400 && Boolean(location);
}

function isSuccessful(statusCode) {
  return statusCode >= 200 && statusCode < 300;
}

async function download(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  validateDownloadOptions(timeoutMs, maxRedirects);

  const deadline = performance.now() + timeoutMs;
  let currentUrl = url;

  for (let redirectCount = 0; ; redirectCount += 1) {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      throw new Error(`Таймаут запроса (${timeoutMs} мс).`);
    }

    const response = await performRequest(currentUrl, remainingMs, timeoutMs);

    if (isRedirect(response.statusCode, response.location)) {
      if (redirectCount >= maxRedirects) {
        throw new Error(`Превышен лимит редиректов (${maxRedirects}).`);
      }
      currentUrl = parseRedirectUrl(response.location, currentUrl);
      continue;
    }

    if (!isSuccessful(response.statusCode)) {
      throw new Error(`Сервер ответил с HTTP-статусом ${response.statusCode}.`);
    }

    return response.bytes;
  }
}

async function measureDownloads(url, options = {}) {
  const requestCount = options.requestCount ?? REQUEST_COUNT;
  const now = options.now ?? (() => performance.now());

  if (!Number.isInteger(requestCount) || requestCount <= 0) {
    throw new Error("Количество запросов должно быть положительным целым числом.");
  }

  let totalBytes = 0;
  let totalDurationMs = 0;
  const requests = [];

  for (let index = 0; index < requestCount; index += 1) {
    const startedAt = now();
    const bytes = await download(url, options);
    const durationMs = now() - startedAt;

    totalBytes += bytes;
    totalDurationMs += durationMs;
    requests.push({ bytes, durationMs });
  }

  return {
    requestCount,
    totalBytes,
    totalDurationMs,
    averageDurationMs: totalDurationMs / requestCount,
    speedMiBPerSecond: calculateSpeed(totalBytes, totalDurationMs),
    requests
  };
}

function calculateSpeed(totalBytes, totalDurationMs) {
  if (totalDurationMs === 0) return 0;
  return (totalBytes / BYTES_PER_MEBIBYTE) / (totalDurationMs / 1000);
}

function formatResults(results) {
  const totalMiB = (results.totalBytes / BYTES_PER_MEBIBYTE).toFixed(2);

  return [
    `Запросов: ${results.requestCount}`,
    `Среднее время запроса: ${results.averageDurationMs.toFixed(2)} мс`,
    `Скачано всего: ${results.totalBytes} байт (${totalMiB} MiB)`,
    `Средняя скорость скачивания: ${results.speedMiBPerSecond.toFixed(2)} MiB/s`
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const url = parseUrl(argv[0]);
  const results = await measureDownloads(url);
  console.log(formatResults(results));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Ошибка: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  download,
  formatResults,
  measureDownloads,
  parseUrl
};
