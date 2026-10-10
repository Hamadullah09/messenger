import { Module } from '@nestjs/common';
import { BusinessesService } from './businesses.service';
import { StoresService } from './stores.service';
import { BusinessesController, StoresController } from './tenancy.controller';

@Module({
  controllers: [BusinessesController, StoresController],
  providers: [BusinessesService, StoresService],
  exports: [BusinessesService, StoresService],
})
export class TenancyModule {}
