import React from 'react';

interface InfoRowProps {
  label: string;
  value: string;
  valueClassName?: string;
  containerClassName?: string;
}

const InfoRow: React.FC<InfoRowProps> = ({
  label,
  value,
  containerClassName = '',
  valueClassName = 'text-sm text-muted-foreground',
}) => {
  return (
    <div
      className={`bg-card px-4 h-10 flex items-center justify-between w-full ${containerClassName}`}
    >
      <span className="text-base font-semibold text-foreground">{label}</span>
      <span className={valueClassName}>{value}</span>
    </div>
  );
};

export default InfoRow;
