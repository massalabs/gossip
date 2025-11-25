import { Component, ErrorInfo, ReactNode } from 'react';
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
        <div className="bg-white flex items-center justify-center p-4 h-full">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-red-600 mb-4">
              Something went wrong
            </h1>
            <p className="text-gray-600 mb-4">
              {this.state.error?.message || 'An unexpected error occurred'}
            </p>
            <Button
              onClick={() => window.location.reload()}
              variant="primary"
              size="md"
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded"
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
