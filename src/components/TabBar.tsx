import { IconChart, IconHistory, IconHome, IconSettings } from './Icons';

export type Tab = 'home' | 'history' | 'charts' | 'settings';
const TABS: { id: Tab; label: string; Icon: typeof IconHome }[] = [
  { id: 'home', label: 'Home', Icon: IconHome },
  { id: 'history', label: 'History', Icon: IconHistory },
  { id: 'charts', label: 'Charts', Icon: IconChart },
  { id: 'settings', label: 'Settings', Icon: IconSettings },
];

export function TabBar({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map(({ id, label, Icon }) => (
        <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => onChange(id)}>
          <Icon />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
