import { NavLink, Route, Routes } from 'react-router-dom';
import Dashboard from './pages/Dashboard.jsx';
import Repositories from './pages/Repositories.jsx';
import RepositoryDetail from './pages/RepositoryDetail.jsx';
import Stories from './pages/Stories.jsx';
import StoryDetail from './pages/StoryDetail.jsx';
import Packages from './pages/Packages.jsx';
import PackageDetail from './pages/PackageDetail.jsx';
import Topics from './pages/Topics.jsx';
import TopicDetail from './pages/TopicDetail.jsx';
import OwnerDetail from './pages/OwnerDetail.jsx';
import AuthorDetail from './pages/AuthorDetail.jsx';
import MaintainerDetail from './pages/MaintainerDetail.jsx';
import Collections from './pages/Collections.jsx';
import Sync from './pages/Sync.jsx';
import Playground from './pages/Playground.jsx';

const NAV = [
  ['/', 'Обзор', '◎'],
  ['/repos', 'Репозитории', '⌂'],
  ['/stories', 'Hacker News', '✎'],
  ['/packages', 'npm-пакеты', '▣'],
  ['/topics', 'Топики', '#'],
  ['/collections', 'Коллекции', '★'],
  ['/sync', 'Сбор данных', '⟳'],
  ['/playground', 'Конструктор', '{ }'],
];

export default function App() {
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">◆</span> DevPulse
        </div>
        <nav>
          {NAV.map(([to, label, icon]) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="nav-icon">{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <a href="/graphql" target="_blank" rel="noreferrer">Apollo Sandbox ↗</a>
          <a href="http://localhost:3000" target="_blank" rel="noreferrer">Grafana ↗</a>
          <a href="http://localhost:16686" target="_blank" rel="noreferrer">Jaeger ↗</a>
        </div>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/repos" element={<Repositories />} />
          <Route path="/repos/:owner/:name" element={<RepositoryDetail />} />
          <Route path="/owners/:login" element={<OwnerDetail />} />
          <Route path="/stories" element={<Stories />} />
          <Route path="/stories/:id" element={<StoryDetail />} />
          <Route path="/authors/:name" element={<AuthorDetail />} />
          <Route path="/packages" element={<Packages />} />
          <Route path="/packages/*" element={<PackageDetail />} />
          <Route path="/maintainers/:name" element={<MaintainerDetail />} />
          <Route path="/topics" element={<Topics />} />
          <Route path="/topics/:name" element={<TopicDetail />} />
          <Route path="/collections" element={<Collections />} />
          <Route path="/sync" element={<Sync />} />
          <Route path="/playground" element={<Playground />} />
          <Route path="*" element={<p className="muted">Страница не найдена</p>} />
        </Routes>
      </main>
    </div>
  );
}
