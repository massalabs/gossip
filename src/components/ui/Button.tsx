import React from 'react';

interface ButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?:
    | 'primary'
    | 'secondary'
    | 'danger'
    | 'ghost'
    | 'outline'
    | 'gradient-emerald'
    | 'gradient-blue'
    | 'circular'
    | 'link'
    | 'icon';
  size?: 'sm' | 'md' | 'lg' | 'custom';
  className?: string;
  type?: 'button' | 'submit' | 'reset';
  fullWidth?: boolean;
  title?: string;
  ariaLabel?: string;
}

const Button: React.FC<ButtonProps> = ({
  children,
  onClick,
  disabled = false,
  loading = false,
  variant = 'primary',
  size = 'md',
  className = '',
  type = 'button',
  fullWidth = false,
  title,
  ariaLabel,
}) => {
  const baseClasses =
    'inline-flex items-center justify-center font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:cursor-not-allowed';

  const variantClasses = {
    primary:
      'bg-primary hover:bg-primary/90 disabled:bg-muted text-primary-foreground disabled:text-muted-foreground focus:ring-ring',
    secondary:
      'bg-secondary hover:bg-secondary/80 disabled:bg-muted text-secondary-foreground disabled:text-muted-foreground focus:ring-ring',
    danger:
      'bg-destructive hover:bg-destructive/90 disabled:bg-destructive/50 text-destructive-foreground focus:ring-ring',
    ghost: 'bg-transparent hover:bg-accent text-foreground focus:ring-ring',
    outline:
      'bg-card border border-border text-foreground hover:bg-accent/50 hover:border-accent shadow-sm hover:shadow-md disabled:bg-muted disabled:text-muted-foreground disabled:border-border/50 disabled:opacity-60 disabled:hover:bg-muted disabled:hover:border-border/50 disabled:hover:shadow-sm',
    'gradient-emerald':
      'bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm',
    'gradient-blue': 'bg-blue-600 hover:bg-blue-700 text-white shadow-sm',
    circular: 'rounded-full hover:bg-accent/50 active:scale-95',
    link: 'bg-transparent text-primary hover:text-primary/80 underline p-0 shadow-none',
    icon: 'bg-transparent hover:bg-accent/50 rounded-full p-2',
  };

  const sizeClasses = {
    sm: 'px-3 py-2 text-sm rounded-lg',
    md: 'px-4 py-3 text-base rounded-xl',
    lg: 'px-6 py-4 text-lg rounded-xl',
    custom: '', // Allow full customization via className
  };

  const widthClasses = fullWidth ? 'w-full' : '';

  // For circular and icon variants, don't apply default size classes
  const shouldApplySize =
    variant !== 'circular' && variant !== 'icon' && size !== 'custom';

  const combinedClasses = `${baseClasses} ${variantClasses[variant]} ${
    shouldApplySize ? sizeClasses[size] : ''
  } ${widthClasses} ${className}`.trim();

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      className={combinedClasses}
      title={title}
      aria-label={ariaLabel}
    >
      {loading && (
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-2" />
      )}
      {children}
    </button>
  );
};

export default Button;
