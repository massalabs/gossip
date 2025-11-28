import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import NavButton from './NavButton';
import {
  // WalletIcon,
  DiscussionsIcon,
  SettingsIcon,
} from './icons';
import { ROUTES } from '../../constants/routes';

type BottomNavigationTab = 'discussions' | 'settings';

const BottomNavigation: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  // Use route.isActive() for cleaner active state detection
  const activeTab: BottomNavigationTab = ROUTES.settings.isActive(
    location.pathname
  )
    ? 'settings'
    : 'discussions';

  const navItems = [
    {
      id: 'discussions' as const,
      path: ROUTES.discussions(),
      title: 'Discussions',
      icon: <DiscussionsIcon />,
    },
    {
      id: 'settings' as const,
      path: ROUTES.settings(),
      title: 'Settings',
      icon: <SettingsIcon />,
    },
  ];

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-card mx-auto h-(--bottom-nav-height) max-w-md flex items-center justify-center shadow-2xl z-50 border-t border-border">
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
