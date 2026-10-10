import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  addMembersRequestSchema,
  createDirectConversationRequestSchema,
  createGroupRequestSchema,
  directoryQuerySchema,
  editMessageRequestSchema,
  forwardMessageRequestSchema,
  listConversationsQuerySchema,
  listMessagesQuerySchema,
  paginationQuerySchema,
  reactionRequestSchema,
  searchMessagesQuerySchema,
  sendMessageRequestSchema,
  seqAckSchema,
  updateGroupRequestSchema,
  updateMemberRequestSchema,
  updateMyConversationStateRequestSchema,
  type AddMembersRequest,
  type ConversationDetailDto,
  type ConversationSummaryDto,
  type CreateDirectConversationRequest,
  type CreateGroupRequest,
  type DirectoryQuery,
  type EditMessageRequest,
  type ForwardMessageRequest,
  type ListConversationsQuery,
  type ListMessagesQuery,
  type MessageDto,
  type MessageInfoDto,
  type MessagePageDto,
  type Page,
  type PaginationQuery,
  type PublicUserDto,
  type ReactionRequest,
  type SearchMessagesQuery,
  type SearchResultDto,
  type SendMessageRequest,
  type UpdateGroupRequest,
  type UpdateMemberRequest,
  type UpdateMyConversationStateRequest,
} from '@storeline/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../../infra/http/zod';
import { CurrentActor, type Actor } from '../auth/actor';
import { ConversationQueryService } from './conversation-query.service';
import { ConversationsService } from './conversations.service';
import { DirectoryService } from './directory.service';
import { MessagesService } from './messages.service';
import { ReceiptsService } from './receipts.service';
import { SearchService } from './search.service';

const readRequestSchema = seqAckSchema.pick({ seq: true });

@ApiTags('conversations')
@ApiBearerAuth()
@Controller({ path: 'conversations', version: '1' })
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly queries: ConversationQueryService,
    private readonly messages: MessagesService,
    private readonly receipts: ReceiptsService,
  ) {}

  @Get()
  @ApiZodQuery(listConversationsQuerySchema)
  list(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(listConversationsQuerySchema)) query: ListConversationsQuery,
  ): Promise<Page<ConversationSummaryDto>> {
    return this.queries.listForUser(actor.userId, query);
  }

  @Post('direct')
  @ApiZodBody(createDirectConversationRequestSchema)
  createDirect(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(createDirectConversationRequestSchema)) body: CreateDirectConversationRequest,
  ): Promise<ConversationDetailDto> {
    return this.conversations.createDirect(actor, body);
  }

  @Post('groups')
  @ApiZodBody(createGroupRequestSchema)
  createGroup(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(createGroupRequestSchema)) body: CreateGroupRequest,
  ): Promise<ConversationDetailDto> {
    return this.conversations.createGroup(actor, body);
  }

  @Get(':id')
  get(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationDetailDto> {
    return this.conversations.get(actor, id);
  }

  @Patch(':id')
  @ApiZodBody(updateGroupRequestSchema)
  update(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateGroupRequestSchema)) body: UpdateGroupRequest,
  ): Promise<ConversationDetailDto> {
    return this.conversations.updateGroup(actor, id, body);
  }

  @Patch(':id/me')
  @ApiZodBody(updateMyConversationStateRequestSchema)
  updateMyState(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateMyConversationStateRequestSchema))
    body: UpdateMyConversationStateRequest,
  ): Promise<ConversationSummaryDto> {
    return this.conversations.updateMyState(actor, id, body);
  }

  @Post(':id/members')
  @ApiZodBody(addMembersRequestSchema)
  addMembers(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(addMembersRequestSchema)) body: AddMembersRequest,
  ): Promise<ConversationDetailDto> {
    return this.conversations.addMembers(actor, id, body);
  }

  @Patch(':id/members/:userId')
  @ApiZodBody(updateMemberRequestSchema)
  updateMember(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodPipe(updateMemberRequestSchema)) body: UpdateMemberRequest,
  ): Promise<ConversationDetailDto> {
    return this.conversations.updateMember(actor, id, userId, body);
  }

  @Delete(':id/members/:userId')
  @HttpCode(204)
  async removeMember(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.conversations.removeMember(actor, id, userId);
  }

  @Get(':id/messages')
  @ApiZodQuery(listMessagesQuerySchema)
  listMessages(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(listMessagesQuerySchema)) query: ListMessagesQuery,
  ): Promise<MessagePageDto> {
    return this.messages.list(actor, id, query);
  }

  /** 201 for a new message; 200 with the original message for an idempotent retry. */
  @Post(':id/messages')
  @ApiZodBody(sendMessageRequestSchema)
  async send(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(sendMessageRequestSchema)) body: SendMessageRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MessageDto> {
    const result = await this.messages.send(actor, id, body);
    res.status(result.duplicate ? 200 : 201);
    return result.message;
  }

  @Get(':id/pins')
  pins(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MessageDto[]> {
    return this.messages.listPinned(actor, id);
  }

  /** REST fallback for read receipts (the socket event is preferred). */
  @Post(':id/read')
  @HttpCode(204)
  @ApiZodBody(readRequestSchema)
  async markRead(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(readRequestSchema)) body: z.infer<typeof readRequestSchema>,
  ): Promise<void> {
    await this.receipts.acknowledge(actor.userId, id, body.seq, 'read');
  }
}

@ApiTags('messages')
@ApiBearerAuth()
@Controller({ path: 'messages', version: '1' })
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get('starred')
  @ApiZodQuery(paginationQuerySchema)
  starred(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<Page<MessageDto>> {
    return this.messages.listStarred(actor, query.cursor, query.limit);
  }

  @Patch(':id')
  @ApiZodBody(editMessageRequestSchema)
  edit(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(editMessageRequestSchema)) body: EditMessageRequest,
  ): Promise<MessageDto> {
    return this.messages.edit(actor, id, body.body);
  }

  @Delete(':id')
  delete(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MessageDto> {
    return this.messages.delete(actor, id);
  }

  @Put(':id/reaction')
  @ApiZodBody(reactionRequestSchema)
  react(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reactionRequestSchema)) body: ReactionRequest,
  ): Promise<MessageDto> {
    return this.messages.react(actor, id, body.emoji);
  }

  @Delete(':id/reaction')
  unreact(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MessageDto> {
    return this.messages.react(actor, id, null);
  }

  @Post(':id/forward')
  @ApiZodBody(forwardMessageRequestSchema)
  async forward(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(forwardMessageRequestSchema)) body: ForwardMessageRequest,
  ): Promise<MessageDto[]> {
    return (await this.messages.forward(actor, id, body)).map((r) => r.message);
  }

  @Put(':id/star')
  @HttpCode(204)
  async star(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.messages.setStar(actor, id, true);
  }

  @Delete(':id/star')
  @HttpCode(204)
  async unstar(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.messages.setStar(actor, id, false);
  }

  @Put(':id/pin')
  pin(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<MessageDto> {
    return this.messages.setPinned(actor, id, true);
  }

  @Delete(':id/pin')
  unpin(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<MessageDto> {
    return this.messages.setPinned(actor, id, false);
  }

  @Get(':id/info')
  info(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MessageInfoDto> {
    return this.messages.info(actor, id);
  }
}

@ApiTags('directory')
@ApiBearerAuth()
@Controller({ version: '1' })
export class DirectoryController {
  constructor(
    private readonly directory: DirectoryService,
    private readonly search: SearchService,
  ) {}

  @Get('directory')
  @ApiZodQuery(directoryQuerySchema)
  find(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(directoryQuerySchema)) query: DirectoryQuery,
  ): Promise<PublicUserDto[]> {
    return this.directory.search(actor, query);
  }

  @Get('search/messages')
  @ApiZodQuery(searchMessagesQuerySchema)
  searchMessages(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(searchMessagesQuerySchema)) query: SearchMessagesQuery,
  ): Promise<Page<SearchResultDto>> {
    return this.search.searchMessages(actor, query);
  }
}
