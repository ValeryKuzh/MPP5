/**
 * Конструктор фильтра. Формирует входной объект GraphQL с логическими операторами:
 *   { AND: [ { stars: { gte: 1000 } }, { NOT: { language: { eq: "Go" } } } ] }
 * Каждое условие можно инвертировать (NOT), условия объединяются через AND или OR.
 */

const OPERATORS = {
  int: [
    ['gte', '≥'],
    ['lte', '≤'],
    ['gt', '>'],
    ['lt', '<'],
    ['eq', '='],
    ['ne', '≠'],
  ],
  float: [
    ['gte', '≥'],
    ['lte', '≤'],
    ['gt', '>'],
    ['lt', '<'],
  ],
  string: [
    ['eq', '='],
    ['contains', 'содержит'],
    ['startsWith', 'начинается с'],
    ['in', 'одно из (через запятую)'],
    ['ne', '≠'],
  ],
  date: [
    ['gte', 'после'],
    ['lte', 'до'],
  ],
  bool: [['is', '=']],
  list: [['all', 'все из (через запятую)']],
  enumList: [['any', 'одно из']],
};

const splitList = (v) =>
  String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function conditionToFilter(field, cond) {
  const { op, value } = cond;
  let piece;
  switch (field.type) {
    case 'int':
      if (value === '' || Number.isNaN(Number(value))) return null;
      piece = { [field.key]: { [op]: Math.trunc(Number(value)) } };
      break;
    case 'float':
      if (value === '' || Number.isNaN(Number(value))) return null;
      piece = { [field.key]: { [op]: Number(value) } };
      break;
    case 'string':
      if (!value) return null;
      piece = { [field.key]: { [op]: op === 'in' ? splitList(value) : value } };
      break;
    case 'date':
      if (!value) return null;
      piece = { [field.key]: { [op]: new Date(value).toISOString() } };
      break;
    case 'bool':
      piece = { [field.key]: value === 'true' };
      break;
    case 'list':
      if (!value) return null;
      piece = { [field.key]: splitList(value) };
      break;
    case 'enumList':
      if (!value) return null;
      piece = { [field.key]: [value] };
      break;
    case 'text':
      if (!value) return null;
      piece = { [field.key]: value };
      break;
    default:
      return null;
  }
  return cond.not ? { NOT: piece } : piece;
}

/** Преобразует состояние конструктора в GraphQL input */
export function buildFilter(fields, state) {
  const parts = state.conditions
    .map((c) => {
      const field = fields.find((f) => f.key === c.field);
      return field ? conditionToFilter(field, c) : null;
    })
    .filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  return { [state.mode]: parts };
}

export const emptyFilter = { mode: 'AND', conditions: [] };

export default function FilterBuilder({ fields, value, onChange }) {
  const update = (idx, patch) =>
    onChange({ ...value, conditions: value.conditions.map((c, i) => (i === idx ? { ...c, ...patch } : c)) });
  const remove = (idx) => onChange({ ...value, conditions: value.conditions.filter((_, i) => i !== idx) });
  const add = () => {
    const f = fields[0];
    onChange({
      ...value,
      conditions: [...value.conditions, { field: f.key, op: OPERATORS[f.type][0][0], value: defaultValue(f), not: false }],
    });
  };

  return (
    <div className="filter-builder">
      <div className="filter-row">
        <strong className="small">Фильтр</strong>
        {value.conditions.length > 1 && (
          <span className="seg">
            {['AND', 'OR'].map((m) => (
              <button key={m} type="button" className={value.mode === m ? 'on' : ''} onClick={() => onChange({ ...value, mode: m })}>
                {m === 'AND' ? 'И (AND)' : 'ИЛИ (OR)'}
              </button>
            ))}
          </span>
        )}
        <button type="button" className="chip-btn" onClick={add}>
          + условие
        </button>
        {value.conditions.length > 0 && (
          <button type="button" className="chip-btn link" onClick={() => onChange(emptyFilter)}>
            очистить
          </button>
        )}
      </div>
      {value.conditions.map((c, idx) => {
        const field = fields.find((f) => f.key === c.field) || fields[0];
        return (
          <div className="filter-row" key={idx}>
            <label className="small">
              <input type="checkbox" checked={c.not} onChange={(e) => update(idx, { not: e.target.checked })} /> НЕ
            </label>
            <select
              value={c.field}
              onChange={(e) => {
                const f = fields.find((x) => x.key === e.target.value);
                update(idx, { field: f.key, op: OPERATORS[f.type][0][0], value: defaultValue(f) });
              }}
            >
              {fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
            {OPERATORS[field.type].length > 1 ? (
              <select value={c.op} onChange={(e) => update(idx, { op: e.target.value })}>
                {OPERATORS[field.type].map(([op, label]) => (
                  <option key={op} value={op}>
                    {label}
                  </option>
                ))}
              </select>
            ) : (
              <span className="small muted">{OPERATORS[field.type][0][1]}</span>
            )}
            <ValueInput field={field} value={c.value} onChange={(v) => update(idx, { value: v })} />
            <button type="button" className="chip-btn danger" onClick={() => remove(idx)} title="Удалить условие">
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}

function defaultValue(field) {
  if (field.type === 'bool') return 'true';
  if (field.type === 'enumList') return field.options[0];
  return '';
}

function ValueInput({ field, value, onChange }) {
  if (field.type === 'bool') {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="true">да</option>
        <option value="false">нет</option>
      </select>
    );
  }
  if (field.type === 'enumList' || field.options) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {field.type !== 'enumList' && <option value="">—</option>}
        {field.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      type={field.type === 'date' ? 'date' : field.type === 'int' || field.type === 'float' ? 'number' : 'text'}
      value={value}
      placeholder={field.placeholder || 'значение'}
      onChange={(e) => onChange(e.target.value)}
      style={{ width: field.type === 'list' || field.type === 'string' ? 200 : 130 }}
    />
  );
}
