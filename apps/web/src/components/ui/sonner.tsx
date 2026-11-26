'use client';

import { Toaster as Sonner } from 'sonner';

export function Toaster() {
  return (
    <Sonner
      position="top-center"
      toastOptions={{
        classNames: {
          toast: 'rounded-card border border-border-subtle bg-white text-foreground shadow-lg font-sans',
          description: 'text-muted-foreground',
          actionButton: 'bg-brand text-foreground',
        },
      }}
    />
  );
}
