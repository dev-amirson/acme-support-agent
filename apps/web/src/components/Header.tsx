'use client';

import { Activity, KeyRound, Plus } from 'lucide-react';
import { useApp } from '@/lib/store';
import { fmtUsd } from '@/lib/format';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

export function Header() {
  const newConversation = useApp((s) => s.newConversation);
  const toggleDrawer = useApp((s) => s.toggleDrawer);
  const drawerOpen = useApp((s) => s.drawerOpen);
  const totals = useApp((s) => s.totals);
  const config = useApp((s) => s.config);

  return (
    <header className="sticky top-0 z-40 shrink-0 border-b border-border-subtle bg-background">
      <div className="flex h-14 items-center gap-3 px-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="text-[15px] font-bold tracking-tight">Acme Cloud Support</span>
          <span className="hidden truncate text-xs text-muted-foreground md:inline">
            AI agent · {config?.models.chat ?? '—'}
            {config?.offlineMode ? ' · offline mode' : ''}
          </span>
        </div>

        <nav className="ml-auto flex items-center gap-1.5">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="nav" size="sm">
                <KeyRound />
                <span className="hidden sm:inline">Demo accounts</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(92vw,400px)] p-0">
              <div className="border-b border-border-subtle bg-surface-header px-3 py-2.5">
                <div className="text-[15px] font-bold">Demo accounts</div>
                <p className="text-[11px] text-muted-foreground">Verify with account ID + ZIP. Each conversation is an isolated sandbox.</p>
              </div>
              <ul className="divide-y divide-border-subtle">
                {config?.demoAccounts.map((a) => (
                  <li key={a.accountId} className="px-3 py-2">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-bold">{a.name}</span>
                      <Badge variant="secondary" className="uppercase tracking-wide">
                        {a.tier}
                      </Badge>
                      <span className="ml-auto font-mono text-xs text-muted-foreground">
                        {a.accountId} · {a.zip}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{a.scenario}</div>
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>

          <Button variant="nav" size="sm" onClick={() => void newConversation()} title="Start a new conversation">
            <Plus />
            <span className="hidden sm:inline">New chat</span>
          </Button>

          <Button variant={drawerOpen ? 'navActive' : 'nav'} size="sm" onClick={() => toggleDrawer()} title="Observability (⌘/Ctrl + .)">
            <Activity />
            <span className="hidden sm:inline">Observability</span>
            <span className="hidden font-mono text-[11px] tabular-nums opacity-70 md:inline">{fmtUsd(totals.costUsd)}</span>
          </Button>
        </nav>
      </div>
    </header>
  );
}
