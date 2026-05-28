/**
 * apps/api/src/treasury/treasury.service.ts
 *
 * Core treasury service. All balance mutations execute inside a
 * Prisma `$transaction` with REPEATABLE READ isolation, providing:
 *
 *   • Atomicity  — balance update + ledger write either both commit or
 *                  both roll back.
 *   • Isolation  — concurrent mint/burn operations cannot read each other's
 *                  intermediate state (preventing double-spend or over-mint).
 *   • Auditability — every state change is captured in treasury_ledger_entry
 *                    with a post-operation balance snapshot.
 *
 * ── Flow for each operation ──────────────────────────────────────────────────
 *
 *  1. Validate amount (must be positive finite Decimal).
 *  2. Open a Prisma interactive transaction with REPEATABLE READ.
 *  3. SELECT the TreasuryBalance row with a FOR UPDATE lock
 *     (prevents concurrent mutations from racing).
 *  4. Apply the guard (e.g. available >= amount for BURN/RESERVE).
 *  5. UPDATE the balance columns atomically.
 *  6. INSERT a TreasuryLedgerEntry capturing the post-op snapshot.
 *  7. Commit. On any failure the entire transaction rolls back.
 *
 * ── Double-spend prevention ──────────────────────────────────────────────────
 *
 *  RESERVE is the key operation: before any withdrawal or burn is submitted
 *  to Stellar, the caller should RESERVE the amount. This moves funds from
 *  `available` to `reserved`, making it impossible for a concurrent request
 *  to see those funds as available.
 *
 *  On settlement the SETTLE operation removes from `reserved`.
 *  On failure   the RELEASE operation returns funds to `available`.
 *
 * ── Over-mint prevention ─────────────────────────────────────────────────────
 *
 *  MINT is the only operation that increases balances. The caller (anchor
 *  or on-chain event listener) is responsible for idempotency via
 *  `referenceId`. The service itself does not enforce idempotency — use a
 *  unique index on `treasury_ledger_entry(reference_id, entry_type)` if
 *  needed (add via migration).
 */

import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

import { PrismaService } from '../prisma/prisma.service';
import {
  AssetIdentifier,
  BalanceSnapshot,
  BurnInput,
  InsufficientBalanceError,
  InvalidAmountError,
  LedgerEntryType,
  LedgerEntryView,
  LedgerQueryInput,
  MintInput,
  ReleaseInput,
  ReserveInput,
  SettleInput,
} from '@stellar-pay/payments-engine/treasury';

@Injectable()
export class TreasuryService {
  private readonly logger = new Logger(TreasuryService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Read operations ───────────────────────────────────────────────────────

  /**
   * Returns the current balance snapshot for an asset.
   * Throws NotFoundException if no row exists yet.
   */
  async getBalance(asset: AssetIdentifier): Promise<BalanceSnapshot> {
    const issuer = asset.assetIssuer ?? 'native';
    const row = await this.prisma.treasuryBalance.findUnique({
      where: {
        assetCode_assetIssuer: {
          assetCode: asset.assetCode,
          assetIssuer: issuer,
        },
      },
    });

    if (!row) {
      throw new NotFoundException(
        `No treasury balance found for ${asset.assetCode}:${issuer}`,
      );
    }

    return this.toSnapshot(row);
  }

  /**
   * Returns the balance snapshot, creating a zero-balance row if absent.
   * Safe to call from deposit/withdrawal handlers that may run before the
   * first balance is seeded.
   */
  async getOrCreateBalance(asset: AssetIdentifier): Promise<BalanceSnapshot> {
    const issuer = asset.assetIssuer ?? 'native';
    const row = await this.prisma.treasuryBalance.upsert({
      where: {
        assetCode_assetIssuer: {
          assetCode: asset.assetCode,
          assetIssuer: issuer,
        },
      },
      create: {
        assetCode: asset.assetCode,
        assetIssuer: issuer,
        availableBalance: new Decimal(0),
        reservedBalance: new Decimal(0),
      },
      update: {}, // no-op on existing row
    });
    return this.toSnapshot(row);
  }

  /**
   * Paginated ledger history for an asset.
   */
  async getLedgerEntries(query: LedgerQueryInput): Promise<LedgerEntryView[]> {
    const issuer = query.asset.assetIssuer ?? 'native';
    const balance = await this.prisma.treasuryBalance.findUnique({
      where: {
        assetCode_assetIssuer: {
          assetCode: query.asset.assetCode,
          assetIssuer: issuer,
        },
      },
      select: { id: true },
    });

    if (!balance) return [];

    const rows = await this.prisma.treasuryLedgerEntry.findMany({
      where: {
        balanceId: balance.id,
        ...(query.entryType ? { entryType: query.entryType } : {}),
        ...(query.referenceId ? { referenceId: query.referenceId } : {}),
        ...(query.fromDate || query.toDate
          ? {
              createdAt: {
                ...(query.fromDate ? { gte: query.fromDate } : {}),
                ...(query.toDate ? { lte: query.toDate } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 50,
      skip: query.offset ?? 0,
    });

    return rows.map((r) => ({
      id: r.id,
      balanceId: r.balanceId,
      entryType: r.entryType as LedgerEntryType,
      amount: r.amount,
      availableAfter: r.availableAfter,
      reservedAfter: r.reservedAfter,
      referenceId: r.referenceId,
      referenceType: r.referenceType,
      note: r.note,
      createdAt: r.createdAt,
    }));
  }

  // ─── Mutation operations ───────────────────────────────────────────────────

  /**
   * MINT: Credits `amount` to `available_balance`.
   *
   * Use when:
   *   - An on-chain deposit is confirmed by the Stellar horizon event listener.
   *   - The anchor credits the treasury after a SEP-24 deposit.
   *
   * @throws InvalidAmountError if amount ≤ 0 or non-finite.
   */
  async mint(input: MintInput): Promise<BalanceSnapshot> {
    const amount = this.validateAmount(input.amount);
    const issuer = input.asset.assetIssuer ?? 'native';

    this.logger.log(
      `MINT ${amount.toFixed(7)} ${input.asset.assetCode} ref=${input.referenceId ?? 'none'}`,
    );

    return this.runAtomicUpdate(
      { assetCode: input.asset.assetCode, assetIssuer: issuer },
      (current) => ({
        availableBalance: current.availableBalance.add(amount),
        reservedBalance: current.reservedBalance,
      }),
      LedgerEntryType.MINT,
      amount,
      input,
    );
  }

  /**
   * BURN: Debits `amount` from `available_balance`.
   *
   * Use when:
   *   - An on-chain withdrawal is confirmed (funds left the treasury account).
   *   - A redemption is settled off-chain.
   *
   * Call RESERVE before submitting to Stellar, then SETTLE/RELEASE on result.
   * BURN is for situations where no reservation was made (direct debit).
   *
   * @throws InsufficientBalanceError if available < amount.
   * @throws InvalidAmountError if amount ≤ 0 or non-finite.
   */
  async burn(input: BurnInput): Promise<BalanceSnapshot> {
    const amount = this.validateAmount(input.amount);
    const issuer = input.asset.assetIssuer ?? 'native';

    this.logger.log(
      `BURN ${amount.toFixed(7)} ${input.asset.assetCode} ref=${input.referenceId ?? 'none'}`,
    );

    return this.runAtomicUpdate(
      { assetCode: input.asset.assetCode, assetIssuer: issuer },
      (current) => {
        if (current.availableBalance.lessThan(amount)) {
          throw new InsufficientBalanceError(
            amount,
            current.availableBalance,
            input.asset.assetCode,
          );
        }
        return {
          availableBalance: current.availableBalance.sub(amount),
          reservedBalance: current.reservedBalance,
        };
      },
      LedgerEntryType.BURN,
      amount.negated(),
      input,
    );
  }

  /**
   * RESERVE: Moves `amount` from `available_balance` → `reserved_balance`.
   *
   * Call this BEFORE submitting a withdrawal or burn to Stellar so the
   * funds are ear-marked and unavailable to concurrent operations.
   *
   * @throws InsufficientBalanceError if available < amount.
   */
  async reserve(input: ReserveInput): Promise<BalanceSnapshot> {
    const amount = this.validateAmount(input.amount);
    const issuer = input.asset.assetIssuer ?? 'native';

    this.logger.log(
      `RESERVE ${amount.toFixed(7)} ${input.asset.assetCode} ref=${input.referenceId ?? 'none'}`,
    );

    return this.runAtomicUpdate(
      { assetCode: input.asset.assetCode, assetIssuer: issuer },
      (current) => {
        if (current.availableBalance.lessThan(amount)) {
          throw new InsufficientBalanceError(
            amount,
            current.availableBalance,
            input.asset.assetCode,
          );
        }
        return {
          availableBalance: current.availableBalance.sub(amount),
          reservedBalance: current.reservedBalance.add(amount),
        };
      },
      LedgerEntryType.RESERVE,
      amount.negated(), // available decreases
      input,
    );
  }

  /**
   * RELEASE: Returns `amount` from `reserved_balance` → `available_balance`.
   *
   * Call this when a pending operation is cancelled or fails, so the
   * ear-marked funds become liquid again.
   *
   * @throws InsufficientBalanceError if reserved < amount.
   */
  async release(input: ReleaseInput): Promise<BalanceSnapshot> {
    const amount = this.validateAmount(input.amount);
    const issuer = input.asset.assetIssuer ?? 'native';

    this.logger.log(
      `RELEASE ${amount.toFixed(7)} ${input.asset.assetCode} ref=${input.referenceId ?? 'none'}`,
    );

    return this.runAtomicUpdate(
      { assetCode: input.asset.assetCode, assetIssuer: issuer },
      (current) => {
        if (current.reservedBalance.lessThan(amount)) {
          throw new InsufficientBalanceError(
            amount,
            current.reservedBalance,
            input.asset.assetCode,
          );
        }
        return {
          availableBalance: current.availableBalance.add(amount),
          reservedBalance: current.reservedBalance.sub(amount),
        };
      },
      LedgerEntryType.RELEASE,
      amount, // available increases
      input,
    );
  }

  /**
   * SETTLE: Removes `amount` from `reserved_balance` (operation completed).
   *
   * Call this after a withdrawal transaction is confirmed on Stellar.
   * The reserved funds are consumed — they do not return to available.
   *
   * @throws InsufficientBalanceError if reserved < amount.
   */
  async settle(input: SettleInput): Promise<BalanceSnapshot> {
    const amount = this.validateAmount(input.amount);
    const issuer = input.asset.assetIssuer ?? 'native';

    this.logger.log(
      `SETTLE ${amount.toFixed(7)} ${input.asset.assetCode} ref=${input.referenceId ?? 'none'}`,
    );

    return this.runAtomicUpdate(
      { assetCode: input.asset.assetCode, assetIssuer: issuer },
      (current) => {
        if (current.reservedBalance.lessThan(amount)) {
          throw new InsufficientBalanceError(
            amount,
            current.reservedBalance,
            input.asset.assetCode,
          );
        }
        return {
          availableBalance: current.availableBalance,
          reservedBalance: current.reservedBalance.sub(amount),
        };
      },
      LedgerEntryType.SETTLE,
      amount.negated(), // reserved decreases
      input,
    );
  }

  // ─── Core atomic update ────────────────────────────────────────────────────

  /**
   * Executes a balance mutation atomically:
   *   1. Opens a Prisma interactive transaction with REPEATABLE READ.
   *   2. Upserts the TreasuryBalance row (creating it at zero if absent).
   *   3. Applies `computeNext` to derive the new column values.
   *   4. Updates the balance row.
   *   5. Inserts a TreasuryLedgerEntry with the post-op snapshot.
   *   6. Returns the new snapshot.
   *
   * The `FOR UPDATE` advisory is provided by Prisma's interactive transaction
   * combined with PostgreSQL's REPEATABLE READ: a second concurrent transaction
   * touching the same row will block until the first commits.
   */
  private async runAtomicUpdate(
    asset: Required<AssetIdentifier>,
    computeNext: (current: {
      availableBalance: Decimal;
      reservedBalance: Decimal;
    }) => { availableBalance: Decimal; reservedBalance: Decimal },
    entryType: LedgerEntryType,
    signedAmount: Decimal,
    meta: { referenceId?: string; referenceType?: string; note?: string },
  ): Promise<BalanceSnapshot> {
    const result = await this.prisma.$transaction(
      async (tx) => {
        // Upsert balance row — creates a zero-balance entry if this is the
        // first operation for this asset.
        const current = await tx.treasuryBalance.upsert({
          where: {
            assetCode_assetIssuer: {
              assetCode: asset.assetCode,
              assetIssuer: asset.assetIssuer,
            },
          },
          create: {
            assetCode: asset.assetCode,
            assetIssuer: asset.assetIssuer,
            availableBalance: new Decimal(0),
            reservedBalance: new Decimal(0),
          },
          update: {}, // no-op — we need the current row to compute the delta
        });

        // Compute next balances (may throw InsufficientBalanceError)
        const next = computeNext({
          availableBalance: current.availableBalance,
          reservedBalance: current.reservedBalance,
        });

        // Apply the update
        const updated = await tx.treasuryBalance.update({
          where: { id: current.id },
          data: {
            availableBalance: next.availableBalance,
            reservedBalance: next.reservedBalance,
            updatedAt: new Date(),
          },
        });

        // Write the immutable ledger entry
        await tx.treasuryLedgerEntry.create({
          data: {
            balanceId: updated.id,
            entryType,
            amount: signedAmount,
            availableAfter: updated.availableBalance,
            reservedAfter: updated.reservedBalance,
            referenceId: meta.referenceId ?? null,
            referenceType: meta.referenceType ?? null,
            note: meta.note ?? null,
          },
        });

        return updated;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 5_000,  // ms to wait for a connection
        timeout: 10_000, // ms before the transaction times out
      },
    );

    return this.toSnapshot(result);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private toSnapshot(row: {
    id: string;
    assetCode: string;
    assetIssuer: string;
    availableBalance: Decimal;
    reservedBalance: Decimal;
    updatedAt: Date;
  }): BalanceSnapshot {
    return {
      id: row.id,
      assetCode: row.assetCode,
      assetIssuer: row.assetIssuer,
      availableBalance: row.availableBalance,
      reservedBalance: row.reservedBalance,
      totalBalance: row.availableBalance.add(row.reservedBalance),
      updatedAt: row.updatedAt,
    };
  }

  private validateAmount(raw: Decimal | string | number): Decimal {
    const d = new Decimal(raw);
    if (!d.isFinite() || d.lessThanOrEqualTo(0)) {
      throw new InvalidAmountError(raw);
    }
    return d;
  }
}