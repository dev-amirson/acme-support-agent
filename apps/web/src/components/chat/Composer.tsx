'use client';

import { useRef, useState } from 'react';
import { Mic, SendHorizontal, Square } from 'lucide-react';
import { MAX_USER_MESSAGE_CHARS } from '@acme/contracts';
import { useApp } from '@/lib/store';
import { Button } from '../ui/button';
import { StatusMessage } from '../ui/status-message';

/** Proof8 floating-label field ("MESSAGE") with the actions docked inside the surface. */
export function Composer() {
  const send = useApp((s) => s.send);
  const stop = useApp((s) => s.stop);
  const startVoice = useApp((s) => s.startVoice);
  const busy = useApp((s) => Boolean(s.chatAbort) || Boolean(s.conversation.activeTurnId));
  const voiceEnabled = useApp((s) => s.config?.voiceEnabled ?? false);
  const voiceError = useApp((s) => s.voice.error);
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    if (!text.trim() || busy) return;
    void send(text);
    setText('');
    if (ref.current) ref.current.style.height = '';
  };

  return (
    <div className="space-y-2">
      {voiceError && (
        <StatusMessage type="error" title="Voice unavailable">
          {voiceError}
        </StatusMessage>
      )}
      <div className="field-shell__surface !flex items-end gap-2 !py-2">
        <label className="flex min-w-0 flex-1 flex-col">
          <span className="field-shell__label">Message</span>
          <textarea
            ref={ref}
            rows={1}
            value={text}
            maxLength={MAX_USER_MESSAGE_CHARS}
            placeholder="Ask about billing, refunds, your plan…"
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            className="field-shell__input max-h-40 resize-none"
          />
        </label>
        <Button
          variant="outline"
          size="icon"
          onClick={() => void startVoice()}
          disabled={!voiceEnabled || busy}
          title={voiceEnabled ? 'Talk to the agent (live voice)' : 'Voice is unavailable on this deployment'}
          aria-label="Start voice"
        >
          <Mic />
        </Button>
        {busy ? (
          <Button variant="destructive" size="sm" onClick={stop} title="Stop">
            <Square className="fill-current" /> Stop
          </Button>
        ) : (
          <Button size="sm" onClick={submit} disabled={!text.trim()} title="Send (Enter)">
            Send <SendHorizontal />
          </Button>
        )}
      </div>
    </div>
  );
}
