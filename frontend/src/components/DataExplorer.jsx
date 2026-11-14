import { useEffect, useMemo, useState } from 'react';
import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';
import FilterBuilder, { buildFilter, emptyFilter } from './FilterBuilder.jsx';
import QueryInspector, { MetaLine, useOperationMeta } from './QueryInspector.jsx';
import { ErrorBox, Loading } from './Status.jsx';
import { num } from '../format.js';

function useDebounced(value, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Универсальная таблица сущностей. Текст GraphQL-запроса формируется динамически:
 *  - набор полей (в т.ч. вложенных и из других подграфов) — по выбранным колонкам;
 *  - totalCount включается директивой @include по флажку;
 *  - фильтр (AND/OR/NOT), сортировка (до 3 полей), поиск и курсорная пагинация — через переменные.
 */
export default function DataExplorer({ config }) {
  const {
    operationName,
    rootField,
    filterType,
    sortType,
    keyFields,
    columns,
    sortFields,
    filterFields,
    defaultSort,
    searchPlaceholder,
    searchHint,
  } = config;

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search.trim());
  const [filterState, setFilterState] = useState(emptyFilter);
  const [sort, setSort] = useState(defaultSort);
  const [selected, setSelected] = useState(columns.filter((c) => c.default !== false).map((c) => c.key));
  const [pageSize, setPageSize] = useState(20);
  const [cursor, setCursor] = useState({});
  const [page, setPage] = useState(1);
  const [withTotal, setWithTotal] = useState(true);

  const filter = useMemo(() => buildFilter(filterFields, filterState), [filterFields, filterState]);

  // при изменении условий выборки — на первую страницу
  useEffect(() => {
    setCursor({});
    setPage(1);
  }, [debouncedSearch, filter, sort, pageSize]);

  const activeColumns = columns.filter((c) => selected.includes(c.key));

  const queryText = useMemo(
    () => `query ${operationName}(
  $first: Int, $after: String, $last: Int, $before: String,
  $filter: ${filterType}, $sort: [${sortType}!], $search: String, $withTotal: Boolean!
) {
  ${rootField}(first: $first, after: $after, last: $last, before: $before,
               filter: $filter, sort: $sort, search: $search) {
    totalCount @include(if: $withTotal)
    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    nodes {
      ${keyFields}
      ${activeColumns.map((c) => c.selection).filter(Boolean).join('\n      ')}
    }
  }
}`,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [operationName, rootField, filterType, sortType, keyFields, selected.join(',')],
  );
  const document = useMemo(() => gql(queryText), [queryText]);

  const effectiveSort = debouncedSearch ? sort : sort.filter((s) => s.field !== 'RELEVANCE');
  const variables = {
    ...(cursor.before ? { last: pageSize, before: cursor.before } : { first: pageSize, after: cursor.after ?? null }),
    filter,
    sort: effectiveSort.length ? effectiveSort : null,
    search: debouncedSearch || null,
    withTotal,
  };

  const { data, previousData, loading, error } = useQuery(document, { variables });
  const meta = useOperationMeta(operationName);
  const conn = (data ?? previousData)?.[rootField];

  const toggleColumn = (key) =>
    setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));

  const headerSort = (field) => {
    if (!field) return;
    setSort((s) => {
      const dir = s[0]?.field === field && s[0].direction === 'DESC' ? 'ASC' : 'DESC';
      return [{ field, direction: dir }, ...s.filter((x) => x.field !== field)].slice(0, 3);
    });
  };

  return (
    <div>
      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="toolbar">
          <input
            className="search"
            type="search"
            value={search}
            placeholder={searchPlaceholder}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label className="small">
            На странице{' '}
            <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
              {[10, 20, 50, 100].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <label className="small">
            <input type="checkbox" checked={withTotal} onChange={(e) => setWithTotal(e.target.checked)} /> totalCount
          </label>
        </div>
        {searchHint && <p className="small muted" style={{ margin: '-4px 0 10px' }}>{searchHint}</p>}

        <FilterBuilder fields={filterFields} value={filterState} onChange={setFilterState} />

        <div className="filter-row" style={{ marginTop: 10 }}>
          <strong className="small">Сортировка</strong>
          {sort.map((s, idx) => (
            <span key={idx} className="filter-row" style={{ gap: 4 }}>
              <select
                value={s.field}
                onChange={(e) => setSort(sort.map((x, i) => (i === idx ? { ...x, field: e.target.value } : x)))}
              >
                {sortFields.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="chip-btn"
                onClick={() =>
                  setSort(sort.map((x, i) => (i === idx ? { ...x, direction: x.direction === 'DESC' ? 'ASC' : 'DESC' } : x)))
                }
              >
                {s.direction === 'DESC' ? '↓ по убыванию' : '↑ по возрастанию'}
              </button>
              {sort.length > 1 && (
                <button type="button" className="chip-btn danger" onClick={() => setSort(sort.filter((_, i) => i !== idx))}>
                  ✕
                </button>
              )}
            </span>
          ))}
          {sort.length < 3 && (
            <button
              type="button"
              className="chip-btn"
              onClick={() =>
                setSort([...sort, { field: sortFields.find((f) => !sort.some((s) => s.field === f.value))?.value ?? sortFields[0].value, direction: 'DESC' }])
              }
            >
              + ключ сортировки
            </button>
          )}
        </div>

        <div className="filter-row" style={{ marginTop: 10 }}>
          <strong className="small">Поля</strong>
          {columns.map((c) => (
            <label key={c.key} className="small" title={c.hint}>
              <input type="checkbox" checked={selected.includes(c.key)} onChange={() => toggleColumn(c.key)} /> {c.label}
              {c.remote && <span className="badge" style={{ marginLeft: 4 }}>{c.remote}</span>}
            </label>
          ))}
        </div>
      </div>

      <ErrorBox error={error} partial={Boolean(conn)} />

      <div className="panel">
        <div className="pager" style={{ marginTop: 0, marginBottom: 8 }}>
          <span className="small muted">
            {conn?.totalCount != null ? <>Найдено: <strong>{num(conn.totalCount)}</strong> · </> : null}
            страница {page} {loading && <span className="spinner" />}
          </span>
          <MetaLine meta={meta} />
        </div>
        {!conn && loading ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {activeColumns.map((c) => (
                    <th
                      key={c.key}
                      className={c.num ? 'num' : ''}
                      style={{ cursor: c.sortField ? 'pointer' : 'default' }}
                      onClick={() => headerSort(c.sortField)}
                    >
                      {c.label}
                      {c.sortField && sort[0]?.field === c.sortField && (sort[0].direction === 'DESC' ? ' ↓' : ' ↑')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {conn?.nodes.map((node) => (
                  <tr key={node[keyFields.split(' ')[0]]}>
                    {activeColumns.map((c) => (
                      <td key={c.key} className={c.num ? 'num' : ''}>
                        {c.render(node)}
                      </td>
                    ))}
                  </tr>
                ))}
                {conn && conn.nodes.length === 0 && (
                  <tr>
                    <td colSpan={activeColumns.length} className="muted">
                      Ничего не найдено
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <div className="pager">
          <button
            type="button"
            disabled={!conn?.pageInfo.hasPreviousPage || page === 1}
            onClick={() => {
              setCursor({ before: conn.pageInfo.startCursor });
              setPage((p) => p - 1);
            }}
          >
            ← Назад
          </button>
          <button type="button" className="link small" disabled={page === 1} onClick={() => { setCursor({}); setPage(1); }}>
            в начало
          </button>
          <button
            type="button"
            disabled={!conn?.pageInfo.hasNextPage}
            onClick={() => {
              setCursor({ after: conn.pageInfo.endCursor });
              setPage((p) => p + 1);
            }}
          >
            Вперёд →
          </button>
        </div>
      </div>

      <QueryInspector query={queryText} variables={variables} operationName={operationName} />
    </div>
  );
}
