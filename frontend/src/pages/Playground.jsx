import { useMemo, useState } from 'react';
import { gql } from '@apollo/client';
import { useApolloClient, useQuery } from '@apollo/client/react';
import { ErrorBox, Loading } from '../components/Status.jsx';
import { MetaLine, useOperationMeta } from '../components/QueryInspector.jsx';

/**
 * Конструктор запросов: дерево полей строится по интроспекции федеративной схемы,
 * текст запроса генерируется динамически из отмеченных полей и аргументов.
 */
const INTROSPECTION = gql`
  query Introspection {
    __schema {
      queryType { name }
      types {
        name
        kind
        fields {
          name
          description
          args { name type { ...TypeRef } }
          type { ...TypeRef }
        }
      }
    }
  }
  fragment TypeRef on __Type {
    kind
    name
    ofType { kind name ofType { kind name ofType { kind name } } }
  }
`;

const named = (t) => {
  let cur = t;
  while (cur.ofType) cur = cur.ofType;
  return cur;
};
const typeLabel = (t) => {
  if (t.kind === 'NON_NULL') return `${typeLabel(t.ofType)}!`;
  if (t.kind === 'LIST') return `[${typeLabel(t.ofType)}]`;
  return t.name;
};
const SCALAR_ARG_KINDS = ['SCALAR', 'ENUM'];
const MAX_DEPTH = 7;

const PRESETS = {
  'Репозиторий + HN + npm': {
    repository: {
      __args: { fullName: 'facebook/react' },
      fullName: {},
      stars: {},
      owner: { login: {}, repositoryCount: {} },
      relatedStories: { __args: { first: 3 }, title: {}, points: {}, author: { name: {}, totalPoints: {} } },
      packages: { name: {}, monthlyDownloads: {}, maintainers: { name: {} } },
    },
  },
  'Топик из 3 подграфов': {
    topic: {
      __args: { name: 'graphql' },
      name: {},
      repositoryCount: {},
      packageCount: {},
      repositories: { __args: { first: 3 }, nodes: { fullName: {}, stars: {} } },
      stories: { __args: { first: 3 }, title: {} },
      packages: { __args: { first: 3 }, name: {} },
    },
  },
  'Граф зависимостей': {
    package: {
      __args: { name: 'express' },
      name: {},
      dependencies: { name: {}, package: { name: {}, dependencies: { name: {}, package: { name: {}, monthlyDownloads: {} } } } },
    },
  },
  'Слишком сложный запрос': {
    repositories: {
      __args: { first: 100 },
      nodes: { owner: { repositories: { __args: { first: 100 }, nodes: { fullName: {}, topics: { name: {} } } } } },
    },
  },
};

function literal(value, type) {
  const n = named(type);
  if (value === '' || value == null) return null;
  if (n.kind === 'ENUM') return String(value);
  if (n.name === 'Int') return String(Math.trunc(Number(value)));
  if (n.name === 'Float') return String(Number(value));
  if (n.name === 'Boolean') return value === true || value === 'true' ? 'true' : 'false';
  return JSON.stringify(String(value));
}

function renderSelection(sel, typeName, types, indent) {
  const type = types[typeName];
  const pad = '  '.repeat(indent);
  const lines = [];
  for (const [fieldName, child] of Object.entries(sel)) {
    if (fieldName === '__args') continue;
    const field = type?.fields?.find((f) => f.name === fieldName);
    if (!field) continue;
    const args = Object.entries(child.__args || {})
      .map(([k, v]) => {
        const argDef = field.args.find((a) => a.name === k);
        const lit = argDef && literal(v, argDef.type);
        return lit != null ? `${k}: ${lit}` : null;
      })
      .filter(Boolean);
    const head = `${pad}${fieldName}${args.length ? `(${args.join(', ')})` : ''}`;
    const target = named(field.type);
    if (target.kind === 'OBJECT' || target.kind === 'INTERFACE') {
      const inner = renderSelection(child, target.name, types, indent + 1);
      lines.push(`${head} {\n${inner || `${pad}  __typename`}\n${pad}}`);
    } else {
      lines.push(head);
    }
  }
  return lines.join('\n');
}

function FieldTree({ typeName, types, sel, onChange, depth }) {
  const type = types[typeName];
  if (!type?.fields) return null;
  const fields = type.fields.filter((f) => !f.name.startsWith('_'));
  return (
    <ul>
      {fields.map((f) => {
        const checked = Boolean(sel[f.name]);
        const target = named(f.type);
        const isObject = target.kind === 'OBJECT';
        const toggle = () => {
          const next = { ...sel };
          if (checked) delete next[f.name];
          else next[f.name] = {};
          onChange(next);
        };
        const setArg = (name, value) =>
          onChange({ ...sel, [f.name]: { ...sel[f.name], __args: { ...(sel[f.name].__args || {}), [name]: value } } });
        return (
          <li key={f.name}>
            <label title={f.description || ''}>
              <input type="checkbox" checked={checked} onChange={toggle} disabled={!checked && isObject && depth >= MAX_DEPTH} />
              {f.name} <span className="type">{typeLabel(f.type)}</span>
            </label>
            {checked &&
              f.args
                .filter((a) => SCALAR_ARG_KINDS.includes(named(a.type).kind))
                .map((a) => (
                  <span key={a.name} className="small">
                    {' '}
                    {a.name}
                    {a.type.kind === 'NON_NULL' ? '*' : ''}:
                    <input
                      className="arg"
                      style={{ width: named(a.type).name === 'String' || named(a.type).name === 'ID' ? 130 : 54 }}
                      value={sel[f.name].__args?.[a.name] ?? ''}
                      onChange={(e) => setArg(a.name, e.target.value)}
                    />
                  </span>
                ))}
            {checked && isObject && (
              <FieldTree typeName={target.name} types={types} sel={sel[f.name]} depth={depth + 1} onChange={(v) => onChange({ ...sel, [f.name]: v })} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default function Playground() {
  const { data, loading, error } = useQuery(INTROSPECTION, { fetchPolicy: 'cache-first' });
  const client = useApolloClient();
  const [sel, setSel] = useState(PRESETS['Топик из 3 подграфов']);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const meta = useOperationMeta('Playground');

  const types = useMemo(() => Object.fromEntries((data?.__schema.types ?? []).map((t) => [t.name, t])), [data]);
  const queryText = useMemo(
    () => (data ? `query Playground {\n${renderSelection(sel, data.__schema.queryType.name, types, 1)}\n}` : ''),
    [data, sel, types],
  );

  const run = async () => {
    setRunning(true);
    try {
      const res = await client.query({ query: gql(queryText), fetchPolicy: 'network-only', errorPolicy: 'all' });
      setResult({ data: res.data, error: res.error });
    } catch (err) {
      setResult({ error: err });
    } finally {
      setRunning(false);
    }
  };

  if (loading && !data) return <Loading text="Интроспекция схемы…" />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Конструктор запросов</h1>
          <div className="muted">Дерево полей федеративной схемы — отметьте поля и задайте аргументы, запрос сформируется автоматически</div>
        </div>
      </div>
      <ErrorBox error={error} />
      <div className="toolbar">
        {Object.keys(PRESETS).map((name) => (
          <button key={name} className="chip-btn" onClick={() => setSel(PRESETS[name])}>
            {name}
          </button>
        ))}
        <button className="chip-btn" onClick={() => setSel({})}>очистить</button>
      </div>
      <div className="grid grid-2">
        <div className="panel tree" style={{ maxHeight: '75vh', overflow: 'auto' }}>
          {data && <FieldTree typeName={data.__schema.queryType.name} types={types} sel={sel} onChange={setSel} depth={1} />}
        </div>
        <div>
          <div className="panel">
            <div className="toolbar" style={{ justifyContent: 'space-between' }}>
              <button className="primary" onClick={run} disabled={running || !Object.keys(sel).length}>
                ▶ Выполнить
              </button>
              <MetaLine meta={meta} />
            </div>
            <pre className="code">{queryText}</pre>
          </div>
          {result && (
            <div className="panel" style={{ marginTop: 16 }}>
              <ErrorBox error={result.error} partial={Boolean(result.data)} />
              {result.data && <pre className="code">{JSON.stringify(result.data, null, 2)}</pre>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
