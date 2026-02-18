import React from 'react';
import { useIOSKeyboardWorkaround } from '../../hooks/useKeyboardVisible';

/**
 * Wrapper component that handles iOS keyboard resize workaround.
 * Resizes the entire app when keyboard is visible on iOS to prevent
 * content from being pushed off-screen due to slow keyboard resize.
 *
 * Instead of translating, we resize the height so all content remains visible.
 *
 * See: https://github.com/ionic-team/capacitor-keyboard/issues/19
 */
const IOSKeyboardWrapper: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { active, keyboardHeight } = useIOSKeyboardWorkaround();

  return (
    <div
      className="w-full h-full flex flex-col transition-[height] duration-300 ease-out"
      style={
        active ? { height: `calc(100dvh - ${keyboardHeight}px)` } : undefined
      }
    >
      {children}
    </div>
  );
};

export default IOSKeyboardWrapper;
