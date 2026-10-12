import { Module } from '@nestjs/common';
import { RealtimeEmitterModule } from '../realtime/realtime-emitter.module';
import { BroadcastListsController } from './broadcast.controller';
import { BroadcastService } from './broadcast.service';
import { ConversationAccessService } from './conversation-access.service';
import { ConversationQueryService } from './conversation-query.service';
import { ConversationsService } from './conversations.service';
import { DirectoryService } from './directory.service';
import { MessageWriter } from './message-writer.service';
import { MessagesService } from './messages.service';
import {
  ConversationsController,
  DirectoryController,
  MessagesController,
} from './messaging.controller';
import { ReceiptsService } from './receipts.service';
import { SearchService } from './search.service';

@Module({
  imports: [RealtimeEmitterModule],
  controllers: [
    ConversationsController,
    MessagesController,
    DirectoryController,
    BroadcastListsController,
  ],
  providers: [
    MessageWriter,
    BroadcastService,
    ConversationAccessService,
    ConversationQueryService,
    ConversationsService,
    DirectoryService,
    MessagesService,
    ReceiptsService,
    SearchService,
  ],
  exports: [
    MessageWriter,
    ConversationAccessService,
    ConversationQueryService,
    ReceiptsService,
    MessagesService,
  ],
})
export class MessagingModule {}
