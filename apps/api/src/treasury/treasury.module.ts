/**
 * apps/api/src/treasury/treasury.module.ts
 *
 * Import this module into AppModule:
 *   imports: [TreasuryModule, ...]
 */

import { Module } from '@nestjs/common';
import { TreasuryController } from './treasury.controller';
import { TreasuryService } from './treasury.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TreasuryController],
  providers: [TreasuryService],
  // Export so payments-engine and other modules can inject TreasuryService
  exports: [TreasuryService],
})
export class TreasuryModule {}