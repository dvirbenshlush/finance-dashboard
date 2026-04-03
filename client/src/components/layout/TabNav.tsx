import { type FC } from 'react';

export type TabId = 'cashflow' | 'categorization' | 'assets' | 'loans' | 'calendar';

const TABS = [
  { id: 'cashflow' as TabId,       label: 'תזרים מזומנים',         icon: '📊' },
  { id: 'categorization' as TabId, label: 'קטגוריות',               icon: '🏷️' },
  { id: 'calendar' as TabId,       label: 'לוח שנה',                icon: '📅' },
  { id: 'assets' as TabId,         label: 'תיק נכסים',              icon: '🏠' },
  { id: 'loans' as TabId,          label: 'הלוואות והתחייבויות',    icon: '💳' },
];

interface TabNavProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

const TabNav: FC<TabNavProps> = ({ activeTab, onTabChange }) => (
  <nav className="flex border-b border-gray-200 bg-white shadow-sm overflow-x-auto">
    {TABS.map((tab) => (
      <button
        key={tab.id}
        onClick={() => onTabChange(tab.id)}
        className={`flex items-center gap-2 px-5 py-4 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${
          activeTab === tab.id
            ? 'border-blue-600 text-blue-600 bg-blue-50'
            : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
        }`}
      >
        <span>{tab.icon}</span>
        <span>{tab.label}</span>
      </button>
    ))}
  </nav>
);

export default TabNav;
