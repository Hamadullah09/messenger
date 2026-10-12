import { Controller, Get, Module, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { reportQuerySchema, type ReportDto, type ReportQuery } from '@storeline/shared';
import type { Response } from 'express';
import { ApiZodQuery, ZodPipe } from '../../infra/http/zod';
import { CurrentActor, type Actor } from '../auth/actor';
import { ReportsService } from './reports.service';

@ApiTags('reports')
@ApiBearerAuth()
@Controller({ path: 'reports', version: '1' })
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @ApiZodQuery(reportQuerySchema)
  report(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(reportQuerySchema)) query: ReportQuery,
  ): Promise<ReportDto> {
    return this.reports.report(actor, query);
  }

  /** Excel workbook of the same report. */
  @Get('export.xlsx')
  @ApiZodQuery(reportQuerySchema)
  async excel(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(reportQuerySchema)) query: ReportQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, fileName } = await this.reports.excel(actor, query);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return new StreamableFile(buffer);
  }
}

@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
