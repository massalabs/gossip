import React from 'react';

interface ButtonProps {
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseDown?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  loading?: boolean;
  variant?:
    | 'primary'
    | 'secondary'
    | 'danger'
    | 'ghost'
    | 'outline'
    | 'circular'
    | 'link'
    | 'icon';
  size?: 'sm' | 'md' | 'lg' | 'custom';
  className?: string;
  type?: 'button' | 'submit' | 'reset';
  fullWidth?: boolean;
  title?: string;
  ariaLabel?: string;
  tabIndex?: number;
  onKeyDown?: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
}

const Button: React.FC<ButtonProps> = ({
  children,
  onClick,
  onMouseDown,
  onKeyDown,
  disabled = false,
  loading = false,
  variant = 'primary',
  size = 'md',
  className = '',
  type = 'button',
  fullWidth = false,
  title,
  ariaLabel,
  tabIndex,
}) => {
  const baseClasses = `inline-flex items-center justify-center font-medium transition-all 
    focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 
    focus-visible:ring-offset-transparent disabled:cursor-not-allowed 
    disabled:pointer-events-none disabled:touch-none `;

  const variantClasses = {
    primary:
      'bg-primary hover:bg-primary/90 disabled:bg-muted text-primary-foreground disabled:text-muted-foreground focus:ring-ring rounded-full',
    secondary:
      'bg-secondary hover:bg-secondary/80 disabled:bg-muted text-secondary-foreground disabled:text-muted-foreground focus:ring-ring rounded-md',
    danger:
      'bg-destructive hover:bg-destructive/90 disabled:bg-destructive/50 text-destructive-foreground focus:ring-ring rounded-md',
    ghost:
      'bg-transparent hover:bg-accent text-foreground focus:ring-ring rounded-md',
    outline: `bg-card border border-border text-foreground hover:bg-accent/50 
    hover:border-accent shadow-sm hover:shadow-md disabled:bg-muted 
    disabled:text-muted-foreground disabled:border-border/50 
    disabled:opacity-60 disabled:hover:bg-muted disabled:hover:border-border/50 
    disabled:hover:shadow-sm rounded-md`,
    circular: 'rounded-full hover:bg-accent/50 active:scale-95',
    link: 'bg-transparent text-primary hover:text-primary/80 underline p-0 shadow-none',
    icon: 'bg-transparent hover:bg-accent/50 rounded-full p-2',
  };

  const sizeClasses = {
    sm: 'px-3 py-2 text-sm',
    md: 'px-3 py-4 h-[51px] text-base gap-2.5',
    lg: 'px-6 py-4 text-lg',
    custom: '', // Allow full customization via className
  };

  const widthClasses = fullWidth ? 'w-full' : '';

  // For circular and icon variants, don't apply default size classes
  const shouldApplySize =
    variant !== 'circular' && variant !== 'icon' && size !== 'custom';

  // Check if className contains a rounded-* class to override default border-radius
  // This regex matches all Tailwind rounded classes including:
  // - Standard: rounded-full, rounded-md, rounded-lg, etc.
  // - Arbitrary values: rounded-[10px]
  // - Corner-specific: rounded-t-3xl, rounded-br-[4px], etc.
  // Uses word boundaries to ensure only standalone rounded classes are matched
  const hasCustomRounded = /\brounded(-[\w[\]]+)?\b/.test(className);
  let variantClass = variantClasses[variant];
  if (hasCustomRounded) {
    // Remove default rounded classes from variant when custom rounded is provided
    // Matches any rounded class (standard, arbitrary, or corner-specific)
    variantClass = variantClass.replace(/\s*\brounded(-[\w[\]]+)?\b/g, '');
  }

  const combinedClasses = `${baseClasses} ${variantClass} ${
    shouldApplySize ? sizeClasses[size] : ''
  } ${widthClasses} ${className}`.trim();

  return (
    <button
      type={type}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      disabled={disabled || loading}
      className={combinedClasses}
      title={title}
      aria-label={ariaLabel}
      tabIndex={tabIndex}
    >
      {loading && (
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-2" />
      )}
      {children}
    </button>
  );
};

export default Button;
