'use client';

import {
  MEDIA_ACCEPT_ATTRIBUTE,
  MESSAGE_BODY_MAX_LENGTH,
  type MessageDto,
} from '@storeline/shared';
import { FileText, Pencil, Plus, Reply, SendHorizontal, Smile, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useChatPrefs } from '@/lib/chat-prefs';
import { formatBytes } from '@/lib/media-store';
import { useSocket } from '@/lib/realtime';
import { cx } from '../ui';

const EMOJI = [
  '😀',
  '😊',
  '😂',
  '👍',
  '🙏',
  '❤️',
  '👏',
  '🎉',
  '✅',
  '❗',
  '👀',
  '🙂',
  '😢',
  '🔥',
  '📦',
  '🛒',
  '⏰',
  '📞',
];
const TYPING_REPEAT_MS = 3_000;

export function Composer({
  conversationId,
  disabledReason,
  replyTo,
  editing,
  onCancelReply,
  onCancelEdit,
  onSend,
  onSaveEdit,
  canShareFiles,
  onSendFile,
}: {
  conversationId: string;
  disabledReason: string | null;
  replyTo: MessageDto | null;
  editing: MessageDto | null;
  onCancelReply: () => void;
  onCancelEdit: () => void;
  onSend: (body: string) => void;
  onSaveEdit: (body: string) => void;
  canShareFiles: boolean;
  onSendFile: (file: File, caption: string) => void;
}) {
  const socket = useSocket();
  const enterToSend = useChatPrefs((p) => p.enterToSend);
  const [text, setText] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const lastTypingRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    setText(editing?.body ?? '');
    if (editing || replyTo) textRef.current?.focus();
  }, [editing, replyTo]);

  useEffect(() => {
    setText('');
    setEmojiOpen(false);
    setFile(null);
  }, [conversationId]);

  if (disabledReason) {
    return (
      <div
        className="bg-wa-panel px-4 py-4 text-center text-[0.9rem] text-wa-chip-text"
        role="status"
      >
        {disabledReason}
      </div>
    );
  }

  const trimmed = text.trim();
  const tooLong = text.length > MESSAGE_BODY_MAX_LENGTH;

  function submit() {
    if (tooLong) return;
    if (file && !editing) {
      onSendFile(file, text);
      setFile(null);
    } else {
      if (!trimmed) return;
      if (editing) onSaveEdit(text);
      else onSend(text);
    }
    setText('');
    setEmojiOpen(false);
    socket?.emit('typing.stop', { conversationId });
    lastTypingRef.current = 0;
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Settings → Chats → "Enter is send". Off: Enter adds a line, Ctrl/⌘+Enter sends.
    const sendKey = enterToSend ? !e.shiftKey : e.ctrlKey || e.metaKey;
    if (e.key === 'Enter' && sendKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape') {
      if (editing) onCancelEdit();
      else if (replyTo) onCancelReply();
    }
  }

  function onChange(value: string) {
    setText(value);
    const now = Date.now();
    if (value && now - lastTypingRef.current > TYPING_REPEAT_MS) {
      lastTypingRef.current = now;
      socket?.emit('typing.start', { conversationId });
    }
  }

  const round =
    'inline-flex size-10 shrink-0 items-center justify-center rounded-full text-wa-icon transition-colors hover:bg-wa-hover';
  const card = 'flex items-center gap-3 rounded-lg bg-wa-in px-3 py-2';
  return (
    <div className="shrink-0 bg-wa-panel">
      {(replyTo || editing || file) && (
        <div className="space-y-2 px-4 pt-2 sm:px-16">
          {(replyTo || editing) && (
            <div className={card}>
              <div className="min-w-0 flex-1 border-l-4 border-brand pl-3">
                <p className="flex items-center gap-1.5 text-sm font-semibold text-brand">
                  {editing ? (
                    <Pencil className="size-4" aria-hidden />
                  ) : (
                    <Reply className="size-4" aria-hidden />
                  )}
                  {editing ? 'Editing message' : `Replying to ${replyTo!.sender.displayName}`}
                </p>
                <p className="truncate text-sm text-wa-meta-in">{(editing ?? replyTo)!.body}</p>
              </div>
              <button
                type="button"
                className={round}
                aria-label={editing ? 'Cancel editing' : 'Cancel reply'}
                title={editing ? 'Cancel editing' : 'Cancel reply'}
                onClick={editing ? onCancelEdit : onCancelReply}
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>
          )}
          {file && (
            <div className={card}>
              <span className="inline-flex size-10 items-center justify-center rounded-lg bg-brand-soft text-brand">
                <FileText className="size-6" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{file.name}</p>
                <p className="text-sm text-wa-meta-in">
                  {formatBytes(file.size)} · Add a caption (optional), then press Send
                </p>
              </div>
              <button
                type="button"
                className={round}
                aria-label="Remove file"
                title="Remove file"
                onClick={() => setFile(null)}
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>
          )}
        </div>
      )}
      {emojiOpen && (
        <div
          role="group"
          aria-label="Emoji"
          className="grid grid-cols-6 gap-1 border-b border-wa-divider px-3 py-2 sm:grid-cols-9 sm:px-14"
        >
          {EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`Insert ${emoji}`}
              className="size-11 rounded-lg text-2xl hover:bg-wa-hover"
              onClick={() => {
                setText((t) => t + emoji);
                textRef.current?.focus();
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex items-end gap-1 px-2 py-2 sm:px-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <button
          type="button"
          className={cx(round, emojiOpen && 'text-brand')}
          aria-label={emojiOpen ? 'Close emoji' : 'Add emoji'}
          title={emojiOpen ? 'Close emoji' : 'Add emoji'}
          aria-expanded={emojiOpen}
          onClick={() => setEmojiOpen((v) => !v)}
        >
          {emojiOpen ? (
            <X className="size-6" aria-hidden />
          ) : (
            <Smile className="size-6" aria-hidden />
          )}
        </button>
        {canShareFiles && !editing && (
          <>
            <button
              type="button"
              className={round}
              aria-label="Attach a photo, video or document"
              title="Attach"
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus className="size-6" aria-hidden />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept={MEDIA_ACCEPT_ATTRIBUTE}
              onChange={(e) => {
                const picked = e.target.files?.[0];
                if (picked) setFile(picked);
                e.target.value = '';
                textRef.current?.focus();
              }}
            />
          </>
        )}
        <label className="mx-1 min-w-0 flex-1">
          <span className="sr-only">Message</span>
          <textarea
            ref={textRef}
            rows={1}
            value={text}
            placeholder={file ? 'Add a caption (optional)' : 'Type a message…'}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            title={
              enterToSend
                ? 'Enter to send · Shift + Enter for a new line'
                : 'Ctrl + Enter to send · Enter for a new line'
            }
            className="block max-h-36 min-h-10 w-full resize-none rounded-lg bg-wa-input px-3 py-2 text-[0.95rem] leading-6 [field-sizing:content] placeholder:text-wa-icon wa-field"
          />
        </label>
        <button
          type="submit"
          // Keep the text box focused: otherwise the phone keyboard starts closing, the layout
          // jumps and the tap misses the button (WhatsApp keeps the keyboard open too).
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          aria-label={editing ? 'Save' : 'Send'}
          title={editing ? 'Save' : 'Send'}
          disabled={(!trimmed && !file) || tooLong}
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-brand text-brand-contrast transition-opacity hover:bg-brand-strong disabled:bg-transparent disabled:text-wa-icon"
        >
          <SendHorizontal className="size-5" aria-hidden />
        </button>
      </form>
      {tooLong && (
        <p className="px-4 pb-2 text-sm font-semibold text-danger sm:px-16" role="alert">
          Messages can be at most {MESSAGE_BODY_MAX_LENGTH} characters.
        </p>
      )}
    </div>
  );
}
