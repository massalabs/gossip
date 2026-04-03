import React from 'react';
import { PrivacyGraphic } from '../../components/graphics';

interface LoginLayoutProps {
  title: string;
  username?: string;
  subtitle?: string;
  children: React.ReactNode;
}

export const LoginLayout: React.FC<LoginLayoutProps> = ({
  title,
  username,
  subtitle,
  children,
}) => {
  return (
    <div className="bg-background max-h-full flex min-h-0 w-full app-max-w flex-col overflow-y-auto overflow-x-hidden px-4 py-8 md:py-0">
      <div className="flex min-h-full w-full flex-col items-center justify-center">
        <div className="w-full max-w-md text-center">
          <div
            className=" overflow-hidden"
            style={{
              maskImage:
                'linear-gradient(to bottom, transparent 0%, black 40%, black 70%, transparent 100%)',
              WebkitMaskImage:
                'linear-gradient(to bottom, transparent 0%, black 40%, black 70%, transparent 100%)',
            }}
          >
            <PrivacyGraphic size={200} />
          </div>
          <div className="flex flex-col items-center justify-center">
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-foreground flex flex-col items-center justify-center gap-2">
              {username && (
                <span className="text-primary text-4xl md:text-5xl">
                  {username}
                </span>
              )}
              {title}
            </h1>
            {subtitle && (
              <p className="text-sm text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>

        <div className="w-full max-w-md space-y-2 px-4 pt-4">{children}</div>
      </div>
    </div>
  );
};
