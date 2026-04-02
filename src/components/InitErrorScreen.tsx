import { useState } from 'react';
import { AlertTriangle } from 'react-feather';
import Button from './ui/Button';
import { InitError } from '../utils/initError';

export default function InitErrorScreen({ error }: { error: InitError }) {
  const [loading, setLoading] = useState(false);

  const handleAction = async () => {
    setLoading(true);
    if (error.showClear) {
      // Clear IDB databases
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (db.name?.startsWith('gossip-')) indexedDB.deleteDatabase(db.name);
      }
      // Clear OPFS secure storage blocks/keypairs so next launch starts fresh
      try {
        const root = await navigator.storage.getDirectory();
        // @ts-expect-error entries() exists in modern browsers
        for await (const [name] of root.entries()) {
          if (name.startsWith('gossip')) {
            await root.removeEntry(name, { recursive: true });
          }
        }
      } catch {
        // OPFS not available or already clean
      }
    }
    window.location.reload();
  };

  return (
    <div className="bg-background flex items-center justify-center p-4 h-full">
      <div className="text-center max-w-md mx-auto px-4">
        <div className="mb-6">
          <div className="mx-auto w-12 h-12 bg-destructive/10 rounded-full flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-destructive" />
          </div>
        </div>
        <h1 className="text-2xl font-semibold text-foreground mb-3">
          {error.title}
        </h1>
        <p className="text-muted-foreground mb-6">{error.detail}</p>
        <Button
          onClick={handleAction}
          variant="primary"
          size="custom"
          className="h-12 px-6 rounded-full"
          loading={loading}
        >
          {error.actionLabel}
        </Button>
      </div>
    </div>
  );
}
