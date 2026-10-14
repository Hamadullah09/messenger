import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { ApiZodBody, ZodPipe } from '../../infra/http/zod';
import { CurrentActor, type Actor } from '../auth/actor';
import {
  BusinessDataService,
  type ClosureStatusDto,
  type SetupStatusDto,
} from './business-data.service';

const closureSchema = z.object({ reason: z.string().trim().max(500).optional() });

/** A business's own data: full export, and asking SMA to close the account. */
@ApiTags('businesses')
@ApiBearerAuth()
@Controller({ path: 'businesses/:businessId', version: '1' })
export class BusinessDataController {
  constructor(private readonly data: BusinessDataService) {}

  @Get('export.json')
  async export(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.data.export(
      actor,
      businessId,
      (fileName) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Cache-Control', 'no-store');
      },
      (chunk) =>
        new Promise<void>((resolve, reject) => {
          // Respect back-pressure: wait when the client reads slowly.
          if (res.write(chunk)) resolve();
          else res.once('drain', resolve).once('error', reject);
        }),
    );
    res.end();
  }

  @Get('setup')
  setup(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
  ): Promise<SetupStatusDto> {
    return this.data.setup(actor, businessId);
  }

  @Get('closure')
  closure(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
  ): Promise<ClosureStatusDto> {
    return this.data.closureStatus(actor, businessId);
  }

  @Post('closure')
  @ApiZodBody(closureSchema)
  requestClosure(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body(new ZodPipe(closureSchema)) body: z.infer<typeof closureSchema>,
  ): Promise<ClosureStatusDto> {
    return this.data.requestClosure(actor, businessId, body.reason);
  }

  @Delete('closure')
  cancelClosure(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
  ): Promise<ClosureStatusDto> {
    return this.data.cancelClosure(actor, businessId);
  }
}
