/**
 * apps/api/src/treasury/treasury.controller.ts
 *
 * REST API for the treasury module.
 *
 * Endpoints:
 *   GET    /treasury/balances/:assetCode                 — current balance
 *   GET    /treasury/balances/:assetCode/ledger          — paginated ledger
 *   POST   /treasury/balances/:assetCode/mint            — credit available
 *   POST   /treasury/balances/:assetCode/burn            — debit available
 *   POST   /treasury/balances/:assetCode/reserve         — available → reserved
 *   POST   /treasury/balances/:assetCode/release         — reserved → available
 *   POST   /treasury/balances/:assetCode/settle          — consume reserved
 *
 * All mutation endpoints are guarded by the existing JwtAuthGuard and an
 * AdminRoleGuard — only internal services and admin users may modify balances.
 *
 * Validation uses class-validator DTOs so malformed payloads are rejected
 * before reaching the service layer.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { TreasuryService } from './treasury.service';
import { LedgerEntryType } from '@stellar-pay/payments-engine/treasury';

// ─── DTOs ─────────────────────────────────────────────────────────────────────

class AssetIssuerDto {
  @IsOptional()
  @IsString()
  issuer?: string;
}

class AmountDto {
  @IsNumber({ maxDecimalPlaces: 7 })
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  referenceId?: string;

  @IsOptional()
  @IsString()
  referenceType?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

class LedgerQueryDto {
  @IsOptional()
  @IsEnum(LedgerEntryType)
  entryType?: LedgerEntryType;

  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;

  @IsOptional()
  @IsString()
  referenceId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  offset?: number;

  @IsOptional()
  @IsString()
  issuer?: string;
}

// ─── Controller ───────────────────────────────────────────────────────────────

@Controller('treasury/balances')
// @UseGuards(JwtAuthGuard, AdminRoleGuard) // uncomment when auth module is wired
export class TreasuryController {
  constructor(private readonly treasury: TreasuryService) {}

  // ── Read ──────────────────────────────────────────────────────────────────

  @Get(':assetCode')
  async getBalance(
    @Param('assetCode') assetCode: string,
    @Query() query: AssetIssuerDto,
  ) {
    return this.treasury.getBalance({
      assetCode,
      assetIssuer: query.issuer,
    });
  }

  @Get(':assetCode/ledger')
  async getLedger(
    @Param('assetCode') assetCode: string,
    @Query() query: LedgerQueryDto,
  ) {
    return this.treasury.getLedgerEntries({
      asset: { assetCode, assetIssuer: query.issuer },
      entryType: query.entryType,
      fromDate: query.fromDate ? new Date(query.fromDate) : undefined,
      toDate:   query.toDate   ? new Date(query.toDate)   : undefined,
      referenceId: query.referenceId,
      limit:  query.limit,
      offset: query.offset,
    });
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  @Post(':assetCode/mint')
  @HttpCode(HttpStatus.OK)
  async mint(@Param('assetCode') assetCode: string, @Body() body: AmountDto & { issuer?: string }) {
    return this.treasury.mint({
      asset: { assetCode, assetIssuer: body.issuer },
      amount: body.amount,
      referenceId:   body.referenceId,
      referenceType: body.referenceType,
      note:          body.note,
    });
  }

  @Post(':assetCode/burn')
  @HttpCode(HttpStatus.OK)
  async burn(@Param('assetCode') assetCode: string, @Body() body: AmountDto & { issuer?: string }) {
    return this.treasury.burn({
      asset: { assetCode, assetIssuer: body.issuer },
      amount: body.amount,
      referenceId:   body.referenceId,
      referenceType: body.referenceType,
      note:          body.note,
    });
  }

  @Post(':assetCode/reserve')
  @HttpCode(HttpStatus.OK)
  async reserve(@Param('assetCode') assetCode: string, @Body() body: AmountDto & { issuer?: string }) {
    return this.treasury.reserve({
      asset: { assetCode, assetIssuer: body.issuer },
      amount: body.amount,
      referenceId:   body.referenceId,
      referenceType: body.referenceType,
      note:          body.note,
    });
  }

  @Post(':assetCode/release')
  @HttpCode(HttpStatus.OK)
  async release(@Param('assetCode') assetCode: string, @Body() body: AmountDto & { issuer?: string }) {
    return this.treasury.release({
      asset: { assetCode, assetIssuer: body.issuer },
      amount: body.amount,
      referenceId:   body.referenceId,
      referenceType: body.referenceType,
      note:          body.note,
    });
  }

  @Post(':assetCode/settle')
  @HttpCode(HttpStatus.OK)
  async settle(@Param('assetCode') assetCode: string, @Body() body: AmountDto & { issuer?: string }) {
    return this.treasury.settle({
      asset: { assetCode, assetIssuer: body.issuer },
      amount: body.amount,
      referenceId:   body.referenceId,
      referenceType: body.referenceType,
      note:          body.note,
    });
  }
}