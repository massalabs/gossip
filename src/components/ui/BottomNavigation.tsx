import React from 'react';
import { useLocation, useNavigate, matchPath } from 'react-router-dom';
import { Settings as SettingsFeather } from 'react-feather';
import NavButton from './NavButton';
import GossipIcon from './customIcons/gossip-icon';
import { ROUTES } from '../../constants/routes';

type BottomNavigationTab = 'discussions' | 'settings';

const BottomNavigation: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const activeTab: BottomNavigationTab = matchPath(
    location.pathname,
    ROUTES.settings()
  )
    ? 'settings'
    : 'discussions';

  const navItems = [
    {
      id: 'discussions' as const,
      path: ROUTES.discussions(),
      title: 'Discussions',
      icon: <GossipIcon size={24} />,
    },
    {
      id: 'settings' as const,
      path: ROUTES.settings(),
      title: 'Settings',
      icon: <SettingsFeather />,
    },
  ];

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-card mx-auto h-(--bottom-nav-height) app-max-w flex items-center justify-center shadow-2xl z-50 border border-border rounded-lg">
      <div className="flex items-center justify-center gap-8">
        {navItems.map(item => (
          <NavButton
            key={item.id}
            onClick={() => navigate(item.path)}
            isActive={activeTab === item.id}
            title={item.title}
            icon={item.icon}
          />
        ))}
      </div>
    </div>
  );
};

export default BottomNavigation;
