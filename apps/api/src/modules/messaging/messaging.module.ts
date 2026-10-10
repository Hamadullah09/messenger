import { Module } from '@nestjs/common';
import { RealtimeEmitterModule } from '../realtime/realtime-emitter.module';
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
  controllers: [ConversationsController, MessagesController, DirectoryController],
  providers: [
    MessageWriter,
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
