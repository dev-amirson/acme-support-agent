'use client';

import { TOOL_NAMES, type ToolName } from '@acme/contracts';
import { useApp } from '@/lib/store';
import { Button } from '../ui/button';
import { SectionCard } from '../ui/card';
import { SelectField } from '../ui/select';
import { StatusMessage } from '../ui/status-message';
import { Switch } from '../ui/switch';

function SwitchRow({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 py-2.5">
      <span>
        <span className="block text-sm font-bold">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    </label>
  );
}

/**
 * Arms one-shot failures for this session so recovery paths can be demonstrated live: transparent
 * retries, model fallback, tool retry/backoff and graceful degradation to a human.
 */
export function FailureLab() {
  const chaos = useApp((s) => s.chaos);
  const setChaos = useApp((s) => s.setChaos);
  const enabled = useApp((s) => s.config?.chaosEnabled ?? false);

  if (!enabled) {
    return (
      <StatusMessage type="info" title="Disabled" className="bg-white">
        Failure injection is disabled on this deployment.
      </StatusMessage>
    );
  }

  return (
    <>
      <StatusMessage type="info" title="How it works" className="bg-white">
        Arm a failure, then send a message. Each one fires once and disarms itself — watch the step timeline, the recovery notes and the Trace tab.
      </StatusMessage>

      <SectionCard title="Model provider" contentClassName="divide-y divide-border-subtle py-0">
        <SwitchRow
          checked={chaos.rateLimit}
          onChange={(v) => void setChaos({ rateLimit: v })}
          label="Rate limit (HTTP 429)"
          hint="Retried with backoff honouring Retry-After — the customer only sees a status note."
        />
        <SwitchRow
          checked={chaos.llmTimeout}
          onChange={(v) => void setChaos({ llmTimeout: v })}
          label="Stall the next model call"
          hint="The first-token watchdog aborts and retries; repeated failure falls back to a second model family."
        />
      </SectionCard>

      <SectionCard title="Internal systems (tools)" description="Fail the next call of one tool" contentClassName="space-y-2.5">
        <SelectField
          label="Tool"
          value={chaos.failTool ?? 'none'}
          onValueChange={(v) => void setChaos({ failTool: v === 'none' ? null : (v as ToolName) })}
          options={[{ value: 'none', label: 'No tool failure' }, ...TOOL_NAMES.map((t) => ({ value: t, label: t }))]}
        />
        <div className="flex gap-1.5">
          {(['transient', 'persistent'] as const).map((mode) => (
            <Button
              key={mode}
              variant={chaos.failToolMode === mode ? 'navActive' : 'outline'}
              size="sm"
              className="flex-1 normal-case tracking-normal"
              onClick={() => void setChaos({ failToolMode: mode })}
            >
              {mode === 'transient' ? 'Transient — retry recovers' : 'Persistent — outage'}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          A persistent outage comes back to the agent as a structured <code className="font-mono">TOOL_UNAVAILABLE</code> result — it apologises, doesn&apos;t guess, and offers a human.
        </p>
      </SectionCard>
    </>
  );
}
