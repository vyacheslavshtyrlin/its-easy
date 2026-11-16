#!/usr/bin/env node

"use strict";

const http = require("node:http");
const https = require("node:https");
const { performance } = require("node:perf_hooks");
const REQUEST_COUNT = 10;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

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

function download(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("Таймаут должен быть положительным числом."));
  }
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    return Promise.reject(new Error("Лимит редиректов должен быть неотрицательным целым числом."));
  }

  const deadline = performance.now() + timeoutMs;
  return downloadWithRedirects(url, maxRedirects, 0, deadline, timeoutMs);
}

function downloadWithRedirects(url, maxRedirects, redirectCount, deadline, timeoutMs) {
  const client = url.protocol === "https:" ? https : http;
  const remainingMs = deadline - performance.now();

  if (remainingMs <= 0) {
    return Promise.reject(new Error(`Таймаут запроса (${timeoutMs} мс).`));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const succeed = (value) => finish(resolve, value);
    const fail = (error) => finish(reject, error);

    const request = client.get(
      url,
      {
        headers: {
          "accept-encoding": "identity",
          "user-agent": "download-speed-cli/1.0"
        }
      },
      (response) => {
        if (settled) {
          response.destroy();
          return;
        }

        const statusCode = response.statusCode ?? 0;
        const location = response.headers.location;

        response.once("error", fail);
        response.once("aborted", () => {
          fail(new Error("Соединение разорвано до полного получения ответа."));
        });

        if (statusCode >= 300 && statusCode < 400 && location) {
          response.resume();
          response.once("end", () => {
            if (settled) return;

            if (redirectCount >= maxRedirects) {
              fail(new Error(`Превышен лимит редиректов (${maxRedirects}).`));
              return;
            }

            let nextUrl;
            try {
              nextUrl = new URL(location, url);
            } catch {
              fail(new Error(`Некорректный адрес редиректа: ${location}`));
              return;
            }

            if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
              fail(new Error(`Редирект на неподдерживаемый протокол: ${nextUrl.protocol}`));
              return;
            }

            clearTimeout(timer);
            downloadWithRedirects(
              nextUrl,
              maxRedirects,
              redirectCount + 1,
              deadline,
              timeoutMs
            ).then(succeed, fail);
          });
          return;
        }

        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
        });
        response.once("end", () => {
          if (statusCode < 200 || statusCode >= 300) {
            fail(new Error(`Сервер ответил с HTTP-статусом ${statusCode}.`));
            return;
          }
          succeed(bytes);
        });
      }
    );

    timer = setTimeout(() => {
      const error = new Error(`Таймаут запроса (${timeoutMs} мс).`);
      request.destroy(error);
      fail(error);
    }, remainingMs);
    request.once("error", fail);
  });
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
    speedMiBPerSecond:
      totalDurationMs === 0
        ? 0
        : (totalBytes / (1024 * 1024)) / (totalDurationMs / 1000),
    requests
  };
}

function formatResults(results) {
  return [
    `Запросов: ${results.requestCount}`,
    `Среднее время запроса: ${results.averageDurationMs.toFixed(2)} мс`,
    `Скачано всего: ${results.totalBytes} байт (${(results.totalBytes / (1024 * 1024)).toFixed(2)} MiB)`,
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
