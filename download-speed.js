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

function download(url, options = {}, redirectCount = 0) {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const client = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.get(
      url,
      {
        headers: {
          "accept-encoding": "identity",
          "user-agent": "download-speed-cli/1.0"
        }
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        const location = response.headers.location;

        if (statusCode >= 300 && statusCode < 400 && location) {
          response.resume();
          response.once("end", () => {
            if (redirectCount >= maxRedirects) {
              reject(new Error(`Превышен лимит редиректов (${maxRedirects}).`));
              return;
            }

            const nextUrl = new URL(location, url);
            if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
              reject(new Error(`Редирект на неподдерживаемый протокол: ${nextUrl.protocol}`));
              return;
            }

            download(nextUrl, options, redirectCount + 1).then(resolve, reject);
          });
          return;
        }

        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
        });
        response.once("end", () => {
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`Сервер ответил с HTTP-статусом ${statusCode}.`));
            return;
          }
          resolve(bytes);
        });
        response.once("error", reject);
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Таймаут запроса (${timeoutMs} мс).`));
    });
    request.once("error", reject);
  });
}

async function measureDownloads(url, options = {}) {
  const requestCount = options.requestCount ?? REQUEST_COUNT;
  const now = options.now ?? (() => performance.now());
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
