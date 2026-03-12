import React from 'react';

/**
 * Wrapper that resizes the app when the keyboard is visible.
 * Uses the --keyboard-height CSS variable set directly from the native keyboard
 * event listener (no React in the resize path = zero frame delay).
 *
 * On devices where the OS handles resize (e.g. Samsung), --keyboard-height
 * stays at 0px so no double offset occurs.
 */
const IOSKeyboardWrapper: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  return (
    <div className="w-full flex flex-col keyboard-aware-height">{children}</div>
  );
};

export default IOSKeyboardWrapper;
