'use client';

import { useEffect } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useApp } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Toaster } from './ui/sonner';
import { StatusMessage } from './ui/status-message';
import { Header } from './Header';
import { ChatPanel } from './chat/ChatPanel';
import { ObservabilityDrawer } from './observability/ObservabilityDrawer';

export function SupportConsole() {
  const boot = useApp((s) => s.boot);
  const booting = useApp((s) => s.booting);
  const bootError = useApp((s) => s.bootError);
  const drawerOpen = useApp((s) => s.drawerOpen);
  const toggleDrawer = useApp((s) => s.toggleDrawer);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault();
        toggleDrawer();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleDrawer]);

  if (booting) {
    return (
      <div className="flex h-dvh items-center justify-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" /> Connecting to support…
      </div>
    );
  }
  if (bootError) {
    return (
      <div className="flex h-dvh items-center justify-center px-4">
        <StatusMessage
          type="error"
          title="Can't reach the support service"
          className="w-full max-w-md bg-white"
          action={
            <Button size="sm" onClick={() => void boot()}>
              Retry
            </Button>
          }
        >
          {bootError}
        </StatusMessage>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <Header />
      <div className="relative flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <ChatPanel />
        </main>
        {/* Desktop: docked panel. Mobile: slide-over with backdrop. */}
        <div
          className={cn('fixed inset-0 z-30 bg-black/20 transition-opacity lg:hidden', drawerOpen ? 'opacity-100' : 'pointer-events-none opacity-0')}
          onClick={() => toggleDrawer(false)}
        />
        <aside
          aria-label="Observability"
          className={cn(
            'fixed inset-y-0 right-0 z-40 w-full max-w-[480px] border-l border-border-subtle bg-background shadow-xl transition-transform duration-200 lg:static lg:z-auto lg:shadow-none',
            drawerOpen ? 'translate-x-0' : 'translate-x-full lg:hidden',
          )}
        >
          <ObservabilityDrawer />
        </aside>
      </div>
      <Toaster />
    </div>
  );
}
