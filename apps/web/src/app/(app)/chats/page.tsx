'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { BrandIcon } from '@/components/brand';
import { ChatPanel } from '@/components/chat/chat-panel';
import { ConversationList } from '@/components/chat/conversation-list';
import { NewChatDialog, NewGroupDialog } from '@/components/chat/dialogs';
import { cx, Spinner } from '@/components/ui';
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
          'min-h-0 w-full flex-col border-r border-wa-divider bg-wa-list lg:flex lg:w-[30%] lg:max-w-[440px] lg:min-w-[340px] lg:shrink-0',
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
          <div className="flex flex-1 flex-col items-center justify-center border-b-[6px] border-brand bg-wa-panel px-8 text-center">
            <div className="flex max-w-md flex-col items-center">
              <BrandIcon size={120} className="rounded-full" />
              <h2 className="mt-8 text-[2rem] font-light">SMA for Web</h2>
              <p className="mt-4 text-[0.9rem] leading-6 text-wa-meta-in">
                Choose a chat on the left to start messaging, or press the new chat button to
                message a colleague.
              </p>
            </div>
            <p className="mt-16 text-[0.8rem] text-wa-meta-in">
              SMA Technology · Business messaging
            </p>
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
