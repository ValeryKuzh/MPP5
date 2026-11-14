'use strict';

/** Чтение конфигурации из переменных окружения с значениями по умолчанию. */
const env = (key, def) => {
  const v = process.env[key];
  return v === undefined || v === '' ? def : v;
};

const int = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

const bool = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

const serviceName = () => env('OTEL_SERVICE_NAME', env('SERVICE_NAME', 'devpulse'));

module.exports = { env, int, bool, serviceName };
