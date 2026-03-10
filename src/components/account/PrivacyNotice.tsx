import React from 'react';
import { AlertTriangle, Info } from 'react-feather';

interface NoticeProps {
  title: React.ReactNode;
  content: React.ReactNode;
  className?: string;
  tone?: 'info' | 'warning';
}

const Notice: React.FC<NoticeProps> = ({
  title,
  content,
  className = '',
  tone = 'info',
}) => {
  const isWarning = tone === 'warning';
  const ContainerIcon = isWarning ? AlertTriangle : Info;
  const containerClasses = isWarning
    ? 'bg-warning/10 border border-warning/30'
    : 'bg-muted/30 border border-border';
  const iconClasses = isWarning ? 'text-warning' : 'text-muted-foreground';

  return (
    <div className={`rounded-xl p-4 ${containerClasses} ${className}`}>
      <div className="flex items-start gap-2">
        <ContainerIcon className={`w-4 h-4 mt-0.5 shrink-0 ${iconClasses}`} />
        <div className="flex-1">
          <p className="text-xs font-medium text-foreground mb-1">{title}</p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {content}
          </p>
        </div>
      </div>
    </div>
  );
};

export default Notice;
