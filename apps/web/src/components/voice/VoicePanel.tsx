'use client';

import { LoaderCircle, Mic, MicOff, PhoneOff, RotateCcw } from 'lucide-react';
import type { VoiceState } from '@acme/contracts';
import { useApp } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Badge, type BadgeProps } from '../ui/badge';
import { Button } from '../ui/button';
import { SectionCard } from '../ui/card';
import { StatusMessage } from '../ui/status-message';
import { Waveform } from './Waveform';

const STATE: Record<VoiceState, { label: string; badge: BadgeProps['variant'] }> = {
  connecting: { label: 'Connecting', badge: 'secondary' },
  listening: { label: 'Listening', badge: 'success' },
  user_speaking: { label: "You're speaking", badge: 'info' },
  thinking: { label: 'Thinking', badge: 'warning' },
  speaking: { label: 'Speaking', badge: 'default' },
};

export function VoicePanel() {
  const voice = useApp((s) => s.voice);
  const client = useApp((s) => s.voiceClient);
  const stopVoice = useApp((s) => s.stopVoice);
  const startVoice = useApp((s) => s.startVoice);
  const toggleMute = useApp((s) => s.toggleMute);
  const runningStep = useApp((s) => {
    const last = s.conversation.messages.findLast((m) => m.role === 'assistant' && m.streaming);
    return last?.steps.findLast((st) => st.status === 'running')?.label ?? null;
  });

  if (voice.status === 'error') {
    return (
      <StatusMessage
        type="error"
        title="Voice unavailable"
        className="bg-white"
        action={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void startVoice()}>
              <RotateCcw /> Retry
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void stopVoice()}>
              Back to chat
            </Button>
          </div>
        }
      >
        {voice.error}
      </StatusMessage>
    );
  }

  const connecting = voice.status === 'connecting';
  const state: VoiceState = connecting ? 'connecting' : voice.state;
  const live = !connecting;
  const detail = voice.notice ?? (state === 'thinking' && runningStep ? runningStep : state === 'speaking' ? 'Talk any time to interrupt' : null);

  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          <span className="relative flex size-2.5">
            {live && <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />}
            <span className={cn('relative inline-flex size-2.5 rounded-full', live ? 'bg-success' : 'bg-disabled')} />
          </span>
          Live voice
          <Badge variant={STATE[state].badge}>
            {(connecting || state === 'thinking') && <LoaderCircle className="animate-spin" />}
            {STATE[state].label}
          </Badge>
        </span>
      }
      description={detail ?? undefined}
      actions={
        <>
          <Button variant="outline" size="icon" onClick={toggleMute} disabled={!live} title={voice.muted ? 'Unmute' : 'Mute'} aria-label={voice.muted ? 'Unmute' : 'Mute'}>
            {voice.muted ? <MicOff className="text-danger" /> : <Mic />}
          </Button>
          <Button variant="destructive" size="sm" onClick={() => void stopVoice()}>
            <PhoneOff /> End
          </Button>
        </>
      }
      contentClassName="pb-2 pt-1"
    >
      <Waveform analysers={client?.analysers ?? null} active={live} />
      <div className="min-h-10 text-center text-[15px]">
        {voice.userPartial && (state === 'user_speaking' || state === 'thinking') ? (
          <p>
            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-info">You </span>
            {voice.userPartial}
            {state === 'user_speaking' && <span className="animate-pulse-soft">▍</span>}
          </p>
        ) : voice.caption && state === 'speaking' ? (
          <p className="text-foreground/80">{voice.caption.replace(/\s?\[\d+\]/g, '').replace(/\*\*/g, '')}</p>
        ) : (
          <p className="text-muted-foreground">{connecting ? 'Opening the line…' : state === 'listening' ? 'Go ahead — I’m listening.' : ''}</p>
        )}
      </div>
    </SectionCard>
  );
}
