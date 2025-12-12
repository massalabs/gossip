import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle } from 'react-feather';
import { GroupChatGraphic } from '../graphics';
import Button from './Button';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="bg-background flex items-center justify-center p-4 h-full">
          <div className="text-center max-w-md mx-auto px-4">
            <div className="mb-6">
              <div className="flex flex-col items-center mb-4">
                <GroupChatGraphic size={120} />
                <div className="mt-4 w-12 h-12 bg-destructive/10 rounded-full flex items-center justify-center">
                  <AlertTriangle className="w-6 h-6 text-destructive" />
                </div>
              </div>
            </div>
            <h1 className="text-2xl font-semibold text-foreground mb-3">
              Something went wrong
            </h1>
            <p className="text-muted-foreground mb-6">
              {this.state.error?.message || 'An unexpected error occurred'}
            </p>
            <Button
              onClick={() => window.location.reload()}
              variant="primary"
              size="custom"
              className="h-12 px-6 rounded-full"
            >
              Reload Page
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
