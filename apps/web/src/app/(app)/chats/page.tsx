'use client';

import { MessagesSquare } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ChatPanel } from '@/components/chat/chat-panel';
import { ConversationList } from '@/components/chat/conversation-list';
import { NewChatDialog, NewGroupDialog } from '@/components/chat/dialogs';
import { cx, EmptyState, Spinner } from '@/components/ui';
import { hasPermission, useAuth } from '@/lib/auth-store';

function ChatsScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const selectedId = params.get('c');
  const me = useAuth((s) => s.me);
  const businessId = useAuth((s) => s.activeBusinessId);
  const [newChat, setNewChat] = useState(false);
  const [newGroup, setNewGroup] = useState(false);

  const select = (id: string | null) => router.push(id ? `/chats?c=${id}` : '/chats');

  return (
    <div className="flex min-h-0 flex-1">
      {/* Conversation list: full width on phones until a chat is opened */}
      <div
        className={cx(
          'min-h-0 w-full flex-col border-r border-line bg-surface lg:flex lg:w-[22rem] lg:shrink-0 xl:w-[26rem]',
          selectedId ? 'hidden' : 'flex',
        )}
      >
        <ConversationList
          selectedId={selectedId}
          onSelect={select}
          onNewChat={() => setNewChat(true)}
          onNewGroup={() => setNewGroup(true)}
          canCreateGroup={hasPermission(me, 'group.create', businessId)}
        />
      </div>
      <div
        className={cx('min-h-0 min-w-0 flex-1 flex-col', selectedId ? 'flex' : 'hidden lg:flex')}
      >
        {selectedId ? (
          <ChatPanel key={selectedId} conversationId={selectedId} onBack={() => select(null)} />
        ) : (
          <div className="flex flex-1 items-center justify-center bg-surface">
            <EmptyState
              icon={<MessagesSquare className="size-9" aria-hidden />}
              title="Choose a chat"
            >
              Pick a conversation on the left, or press the + button to message a colleague.
            </EmptyState>
          </div>
        )}
      </div>
      <NewChatDialog open={newChat} onClose={() => setNewChat(false)} onOpened={select} />
      <NewGroupDialog open={newGroup} onClose={() => setNewGroup(false)} onCreated={select} />
    </div>
  );
}

export default function ChatsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <ChatsScreen />
    </Suspense>
  );
}
