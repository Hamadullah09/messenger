'use client';

import {
  MEDIA_ACCEPT_ATTRIBUTE,
  MESSAGE_BODY_MAX_LENGTH,
  type MessageDto,
} from '@storeline/shared';
import { FileText, Paperclip, Pencil, Reply, SendHorizontal, Smile, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { formatBytes } from '@/lib/media-store';
import { useSocket } from '@/lib/realtime';
import { Button, IconButton } from '../ui';

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
        className="m-3 rounded-2xl border border-line bg-surface-2 p-4 text-center font-semibold text-muted sm:m-5"
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
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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

  return (
    <div className="bg-surface px-3 pt-2 pb-3 sm:px-5 sm:pb-4">
      {(replyTo || editing) && (
        <div className="mb-2 flex items-center gap-3 rounded-2xl border-l-4 border-brand bg-brand-soft px-3 py-2">
          {editing ? (
            <Pencil className="size-5 text-brand" aria-hidden />
          ) : (
            <Reply className="size-5 text-brand" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-brand">
              {editing ? 'Editing message' : `Replying to ${replyTo!.sender.displayName}`}
            </p>
            {!editing && <p className="truncate text-sm text-muted">{replyTo!.body}</p>}
          </div>
          <IconButton
            label={editing ? 'Cancel editing' : 'Cancel reply'}
            onClick={editing ? onCancelEdit : onCancelReply}
          >
            <X className="size-5" aria-hidden />
          </IconButton>
        </div>
      )}
      {file && (
        <div className="mb-2 flex items-center gap-3 rounded-2xl border border-brand/50 bg-brand-soft px-3 py-2">
          <FileText className="size-6 text-brand" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{file.name}</p>
            <p className="text-sm text-muted">
              {formatBytes(file.size)} · Add a caption below (optional), then press Send
            </p>
          </div>
          <IconButton label="Remove file" onClick={() => setFile(null)}>
            <X className="size-5" aria-hidden />
          </IconButton>
        </div>
      )}
      {emojiOpen && (
        <div
          role="group"
          aria-label="Emoji"
          className="mb-2 grid grid-cols-6 gap-1 rounded-2xl border border-line bg-surface p-2 shadow-card sm:grid-cols-9"
        >
          {EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`Insert ${emoji}`}
              className="size-11 rounded-lg text-2xl hover:bg-surface-2"
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
        className="rounded-2xl border border-line-strong/50 bg-surface transition-shadow focus-within:border-brand focus-within:ring-4 focus-within:ring-brand/15"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="block">
          <span className="sr-only">Message</span>
          <textarea
            ref={textRef}
            rows={2}
            value={text}
            placeholder={file ? 'Add a caption (optional)' : 'Type a message…'}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            className="block max-h-48 min-h-16 w-full resize-none rounded-t-2xl bg-transparent px-4 pt-3 pb-1 text-[1.05rem] [field-sizing:content] placeholder:text-muted focus:outline-none"
          />
        </label>
        <div className="flex items-center gap-1 px-2 pb-2">
          <p className="hidden flex-1 pl-2 text-xs text-muted md:block">
            Enter to send · Shift + Enter for a new line
          </p>
          <div className="flex-1 md:hidden" />
          <IconButton
            label={emojiOpen ? 'Close emoji' : 'Add emoji'}
            aria-expanded={emojiOpen}
            onClick={() => setEmojiOpen((v) => !v)}
          >
            <Smile className="size-6" aria-hidden />
          </IconButton>
          {canShareFiles && !editing && (
            <>
              <IconButton
                label="Attach a photo, video or document"
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip className="size-6" aria-hidden />
              </IconButton>
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
          <Button
            type="submit"
            className="ml-1"
            disabled={(!trimmed && !file) || tooLong}
            icon={<SendHorizontal className="size-5" aria-hidden />}
          >
            {editing ? 'Save' : 'Send'}
          </Button>
        </div>
      </form>
      {tooLong && (
        <p className="mt-1 text-sm font-semibold text-danger" role="alert">
          Messages can be at most {MESSAGE_BODY_MAX_LENGTH} characters.
        </p>
      )}
    </div>
  );
}
