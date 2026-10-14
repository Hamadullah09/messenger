import { Module } from '@nestjs/common';
import { BusinessDataController } from './business-data.controller';
import { BusinessDataService } from './business-data.service';
import { BusinessesService } from './businesses.service';
import { StoresService } from './stores.service';
import { BusinessesController, StoresController } from './tenancy.controller';

@Module({
  controllers: [BusinessesController, StoresController, BusinessDataController],
  providers: [BusinessesService, StoresService, BusinessDataService],
  exports: [BusinessesService, StoresService],
})
export class TenancyModule {}
