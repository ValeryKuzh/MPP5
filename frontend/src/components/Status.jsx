/** Индикатор загрузки */
export function Loading({ text = 'Загрузка…' }) {
  return (
    <div className="loading">
      <span className="spinner" />
      {text}
    </div>
  );
}

const CODE_TEXT = {
  QUERY_TOO_COMPLEX: 'Запрос слишком сложный',
  RATE_LIMITED: 'Превышен лимит запросов',
  SERVICE_UNAVAILABLE: 'Сервер перегружен',
  BAD_USER_INPUT: 'Некорректные параметры',
  GRAPHQL_VALIDATION_FAILED: 'Ошибка валидации запроса',
};

function describe(error) {
  const list = error?.errors ?? (error ? [error] : []);
  return list.map((e) => {
    const code = e.extensions?.code;
    const service = e.extensions?.serviceName;
    return `${CODE_TEXT[code] ? `${CODE_TEXT[code]}: ` : ''}${e.message}${service ? ` (подграф ${service})` : ''}`;
  });
}

/**
 * Ошибка GraphQL. Если при этом есть данные — это частичный ответ федерации
 * (один из подграфов недоступен), показываем предупреждение вместо ошибки.
 */
export function ErrorBox({ error, partial = false }) {
  if (!error) return null;
  const messages = [...new Set(describe(error))];
  return (
    <div className={partial ? 'warn-box' : 'error-box'}>
      {partial && <strong>Часть данных недоступна — показан частичный результат. </strong>}
      {messages.slice(0, 4).map((m) => (
        <div key={m}>{m}</div>
      ))}
    </div>
  );
}
