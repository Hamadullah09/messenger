import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  createUploadRequestSchema,
  mediaUrlQuerySchema,
  requestPartsSchema,
  type CreateUploadRequest,
  type MediaAssetDto,
  type MediaUrlDto,
  type MediaUrlQuery,
  type RequestPartsRequest,
  type UploadPartsDto,
  type UploadSessionDto,
} from '@storeline/shared';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../../infra/http/zod';
import { CurrentActor, type Actor } from '../auth/actor';
import { MediaService } from './media.service';

@ApiTags('media')
@ApiBearerAuth()
@Controller({ path: 'media', version: '1' })
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /** Starts an upload: returns presigned, size-bound URLs for direct upload to storage. */
  @Post('uploads')
  @ApiZodBody(createUploadRequestSchema)
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(createUploadRequestSchema)) body: CreateUploadRequest,
  ): Promise<UploadSessionDto> {
    return this.media.createUpload(actor, body);
  }

  /** Fresh URLs for missing parts (resume after a network drop or URL expiry). */
  @Post('uploads/:id/parts')
  @HttpCode(200)
  @ApiZodBody(requestPartsSchema)
  parts(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(requestPartsSchema)) body: RequestPartsRequest,
  ): Promise<UploadPartsDto> {
    return this.media.requestParts(actor, id, body.partNumbers);
  }

  @Post('uploads/:id/complete')
  @HttpCode(202)
  complete(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MediaAssetDto> {
    return this.media.complete(actor, id);
  }

  @Delete('uploads/:id')
  @HttpCode(204)
  async cancel(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.media.cancel(actor, id);
  }

  @Get(':id')
  get(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MediaAssetDto> {
    return this.media.get(actor, id);
  }

  /** Short-lived download URL; authorization is re-checked on every request. */
  @Get(':id/url')
  @ApiZodQuery(mediaUrlQuerySchema)
  url(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(mediaUrlQuerySchema)) query: MediaUrlQuery,
  ): Promise<MediaUrlDto> {
    return this.media.downloadUrl(actor, id, query.variant);
  }
}
