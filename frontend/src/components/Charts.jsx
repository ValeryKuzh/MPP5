import { Link } from 'react-router-dom';
import { short } from '../format.js';

/** Горизонтальная гистограмма: [{ label, value, to? }] */
export function Bars({ items, format = short }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="bars">
      {items.map((i) => (
        <div className="bar-row" key={i.label}>
          <span className="bar-label" title={i.label}>
            {i.to ? <Link to={i.to}>{i.label}</Link> : i.label}
          </span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(i.value / max) * 100}%` }} />
          </div>
          <span className="bar-value">{format(i.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** Вертикальные столбцы по годам: [{ year, count }] */
export function Columns({ items }) {
  if (!items?.length) return <p className="muted">Нет данных</p>;
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div>
      <div className="columns">
        {items.map((i) => (
          <div key={i.year} className="column" style={{ height: `${(i.count / max) * 100}%` }} title={`${i.year}: ${i.count}`} />
        ))}
      </div>
      <div className="columns-axis">
        <span>{items[0].year}</span>
        <span>{items[items.length - 1].year}</span>
      </div>
    </div>
  );
}

export function Stat({ label, value, sub, highlight }) {
  return (
    <div className={`panel stat${highlight ? ' highlight' : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}
