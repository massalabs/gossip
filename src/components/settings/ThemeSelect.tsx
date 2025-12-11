import React, { useState } from 'react';
import { Moon, Sun, Smartphone, Check, ChevronRight } from 'react-feather';
import BaseModal from '../ui/BaseModal';
import { Theme } from '../../stores/uiStore';

type ThemeOption = {
  id: Theme;
  label: string;
  icon: React.ComponentType<{ className?: string; size?: number }>;
};

interface ThemeSelectProps {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  onThemeChange: (theme: Theme) => void;
}

const ThemeSelect: React.FC<ThemeSelectProps> = ({
  theme,
  resolvedTheme,
  onThemeChange,
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);

  const themeOptions: ThemeOption[] = [
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'dark', label: 'Dark', icon: Moon },
    { id: 'system', label: 'System', icon: Smartphone },
  ];

  const selectedTheme =
    themeOptions.find(option => option.id === theme) || themeOptions[2];

  const getThemeIcon = () => {
    if (theme === 'system') {
      return Smartphone;
    }
    return resolvedTheme === 'dark' ? Moon : Sun;
  };

  const ThemeIcon = getThemeIcon();

  const handleThemeSelect = (selectedTheme: Theme) => {
    onThemeChange(selectedTheme);
    setIsModalOpen(false);
  };

  return (
    <>
      <div className="bg-card border border-border rounded-xl w-full overflow-hidden">
        {/* Button */}
        <button
          onClick={() => setIsModalOpen(true)}
          className="w-full h-[54px] flex items-center px-4 justify-between hover:bg-muted/50 transition-colors"
        >
          <div className="flex items-center flex-1 min-w-0">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-muted mr-3 flex-shrink-0">
              <ThemeIcon className="text-foreground" size={18} />
            </div>
            <div className="flex flex-col items-start flex-1 min-w-0">
              <span className="text-base font-semibold text-foreground truncate w-full">
                Theme
              </span>
              <span className="text-xs text-muted-foreground truncate w-full">
                {selectedTheme.label}
              </span>
            </div>
          </div>
          <ChevronRight
            className="text-muted-foreground flex-shrink-0"
            size={20}
          />
        </button>
      </div>

      {/* Theme Selection Modal */}
      <BaseModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="Select Theme"
      >
        <div className="space-y-2">
          {themeOptions.map(option => {
            const Icon = option.icon;
            const isSelected = theme === option.id;
            return (
              <button
                key={option.id}
                onClick={() => handleThemeSelect(option.id)}
                className={`w-full flex items-center px-4 py-4 rounded-xl border transition-colors ${
                  isSelected
                    ? 'bg-primary/10 border-primary'
                    : 'bg-card border-border hover:bg-muted/50'
                }`}
              >
                <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-muted mr-3 flex-shrink-0">
                  <Icon className="text-foreground" size={20} />
                </div>
                <span className="text-base font-medium text-foreground flex-1 text-left">
                  {option.label}
                </span>
                {isSelected && (
                  <div className="flex items-center justify-center w-6 h-6 rounded-full bg-primary flex-shrink-0 ml-2">
                    <Check className="text-primary-foreground" size={16} />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </BaseModal>
    </>
  );
};

export default ThemeSelect;
