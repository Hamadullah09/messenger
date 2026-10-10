import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

@Module({
  imports: [MessagingModule],
  controllers: [MediaController],
  providers: [MediaService],
})
export class MediaModule {}
