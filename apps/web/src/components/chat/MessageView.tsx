'use client';

import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AudioLines, BadgeCheck, BookOpen, ChevronDown, Info, LoaderCircle, RotateCcw, ShieldAlert, Zap } from 'lucide-react';
import type { Citation, Confidence } from '@acme/contracts';
import type { UiMessage } from '@/lib/conversation';
import { useApp } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Badge, type BadgeProps } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { StatusMessage } from '../ui/status-message';
import { StepTimeline } from './StepTimeline';

const BAND_VARIANT: Record<Confidence['band'], BadgeProps['variant']> = {
  high: 'success',
  medium: 'warning',
  low: 'destructive',
};

function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="rounded-full focus-visible:shadow-[var(--shadow-focus-brand)]">
          <Badge variant={BAND_VARIANT[confidence.band]}>
            {confidence.band === 'low' ? <ShieldAlert /> : <BadgeCheck />}
            {confidence.band[0]!.toUpperCase() + confidence.band.slice(1)} confidence · {confidence.score.toFixed(2)}
          </Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="border-b border-border-subtle bg-surface-header px-3 py-2 text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">How this was scored</div>
        <div className="p-3">
          <p className="text-sm">{confidence.rationale}</p>
          <dl className="mt-2 divide-y divide-border-subtle">
            {confidence.signals.map((s) => (
              <div key={s.name} className="flex justify-between gap-2 py-1 text-xs" title={s.detail}>
                <dt className="text-muted-foreground">{s.name}</dt>
                <dd className="font-mono font-bold">{s.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CitationChip({ citation, index }: { citation: Citation | undefined; index: number }) {
  return (
    <span className="group relative mx-0.5 inline-block align-super">
      <span className="cursor-help rounded-[5px] bg-brand px-1 font-mono text-[10px] font-bold text-foreground">{index}</span>
      {citation && (
        <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 hidden w-72 -translate-x-1/2 rounded-card border border-border-subtle bg-white p-3 text-left text-xs font-normal leading-snug text-foreground shadow-lg group-hover:block">
          <span className="block font-bold">{citation.docTitle}</span>
          <span className="block text-muted-foreground">{citation.section}</span>
          <span className="mt-1 line-clamp-5 block text-foreground/80">{citation.snippet}</span>
        </span>
      )}
    </span>
  );
}

/** [n] markers → links the markdown renderer turns into citation chips. */
const linkCitations = (text: string) => text.replace(/\[(\d+)\](?!\()/g, '[$1](#cite-$1)');

const Markdown = memo(function Markdown({ text, citations }: { text: string; citations: Citation[] }) {
  return (
    <div className="prose-chat text-[15px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const m = href?.match(/^#cite-(\d+)$/);
            if (m) {
              const index = Number(m[1]);
              return <CitationChip index={index} citation={citations.find((c) => c.index === index)} />;
            }
            return (
              <a href={href} target="_blank" rel="noreferrer" className="font-bold underline decoration-brand decoration-2 underline-offset-2">
                {children}
              </a>
            );
          },
        }}
      >
        {linkCitations(text)}
      </ReactMarkdown>
    </div>
  );
});

function Sources({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState(false);
  if (!citations.length) return null;
  return (
    <div className="w-full">
      <button onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-[0.06em] text-muted-foreground hover:text-foreground">
        <BookOpen className="size-3" />
        {citations.length} source{citations.length === 1 ? '' : 's'}
        <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ul className="mt-1.5 grid gap-1.5">
          {citations.map((c) => (
            <li key={c.chunkId}>
              <Card className="p-2.5 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="rounded-[5px] bg-brand px-1 font-mono text-[10px] font-bold">{c.index}</span>
                  <span className="font-bold">{c.docTitle}</span>
                  <span className="truncate text-muted-foreground">› {c.section}</span>
                  <span className="ml-auto font-mono text-[10px] text-disabled">sim {c.similarity.toFixed(2)}</span>
                </div>
                <p className="mt-1 line-clamp-3 text-foreground/80">{c.snippet}</p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AssistantMessage({ message }: { message: UiMessage }) {
  const retry = useApp((s) => s.retry);
  // Before the first step event arrives, show a placeholder; afterwards the live timeline says it all.
  const thinking = message.streaming && !message.text && message.steps.length === 0;
  const showFooter = !message.streaming && (message.confidence || message.grounding || message.citations.length > 0 || message.interrupted || message.mode === 'voice');

  return (
    <div className="flex animate-fade-in gap-3">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-[11px] font-bold text-brand">AI</div>
      <div className="min-w-0 flex-1">
        <StepTimeline steps={message.steps} live={message.streaming} />

        {message.recoveries.length > 0 && (
          <div className="mb-2 space-y-1">
            {message.recoveries.map((r, i) => (
              <div key={i} className="flex items-center gap-1.5 rounded-compact border border-l-4 border-warning bg-[rgba(237,108,2,0.06)] px-2 py-1 text-xs text-warning">
                <Zap className="size-3.5 shrink-0" /> {r}
              </div>
            ))}
          </div>
        )}

        {thinking && !message.error && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin text-brand-hover" />
            <span className="animate-pulse-soft">Thinking…</span>
          </div>
        )}

        {message.text && (
          <Card className="rounded-tl-[4px] px-4 py-3">
            <Markdown text={message.text} citations={message.citations} />
            {message.streaming && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse-soft rounded-sm bg-brand align-text-bottom" />}
          </Card>
        )}

        {!message.text && !message.streaming && !message.error && message.interrupted && (
          <p className="text-xs italic text-muted-foreground">Interrupted before replying — the customer kept talking.</p>
        )}

        {message.error && (
          <StatusMessage
            type="error"
            title={message.error.code.replaceAll('_', ' ')}
            className="mt-1 bg-white"
            action={
              message.error.retryable && message.retryText ? (
                <Button variant="outline" size="sm" onClick={() => retry(message.key)}>
                  <RotateCcw /> Retry
                </Button>
              ) : undefined
            }
          >
            {message.error.message}
          </StatusMessage>
        )}

        {showFooter && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {message.confidence && <ConfidenceBadge confidence={message.confidence} />}
            {message.grounding && message.grounding.checkedClaims > 0 && message.grounding.passed && (
              <Badge variant="outline">
                <BadgeCheck className="text-success" /> {message.grounding.checkedClaims} detail{message.grounding.checkedClaims === 1 ? '' : 's'} verified
              </Badge>
            )}
            {message.grounding && !message.grounding.passed && (
              <Badge variant="warning" title={[...message.grounding.unsupportedClaims, ...message.grounding.invalidCitations.map((i) => `[${i}]`)].join(', ')}>
                <Info /> Some details couldn&apos;t be verified
              </Badge>
            )}
            {message.mode === 'voice' && (
              <Badge variant="info">
                <AudioLines /> voice
              </Badge>
            )}
            {message.interrupted && <Badge variant="secondary">interrupted</Badge>}
            <Sources citations={message.citations} />
          </div>
        )}
      </div>
    </div>
  );
}

function UserMessage({ message }: { message: UiMessage }) {
  const voice = message.mode === 'voice';
  return (
    <div className="flex animate-fade-in justify-end">
      <div
        className={cn(
          'max-w-[85%] rounded-card rounded-tr-[4px] px-4 py-2.5 text-[15px]',
          voice ? 'border border-l-4 border-border-subtle border-l-info bg-white' : 'bg-brand text-foreground',
          message.pending && 'opacity-80',
        )}
      >
        {voice && <AudioLines className="mb-0.5 mr-1.5 inline size-3.5 text-info" />}
        <span className="whitespace-pre-wrap">{message.text}</span>
      </div>
    </div>
  );
}

export const MessageView = memo(function MessageView({ message }: { message: UiMessage }) {
  return message.role === 'user' ? <UserMessage message={message} /> : <AssistantMessage message={message} />;
});
