# StellarPay Smart Contracts

Soroban smart contracts for the StellarPay payment platform.

## Table of Contents

- [Overview](#overview)
- [Contract Architecture](#contract-architecture)
- [Escrow Contract](#escrow-contract)
- [Subscription Contract](#subscription-contract)
- [Payment Intent Contract](#payment-intent-contract)
- [State Machines](#state-machines)
- [Integration Examples](#integration-examples)

---

## Overview

The StellarPay smart contracts are built on Soroban (Stellar's smart contract platform) and handle:

- **Escrow**: Secure payment holding with milestone-based releases
- **Subscription**: Recurring payment management
- **Payment Intent**: Payment lifecycle management

### Supported Assets

- USDC (Circle)
- ARS (Argentine Peso stablecoin)
- XLM (Stellar native)

---

## Contract Architecture

```
contracts/src/
├── lib.rs           # Contract exports
├── escrow.rs        # Escrow contract
├── subscription.rs # Subscription contract
└── payment_intent.rs # Payment intent contract
```

### Contract Interactions

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   User/Client    │────▶│ Payment Intent   │────▶│    Escrow       │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │                        │
                               ▼                        ▼
                        ┌──────────────────┐     ┌─────────────────┐
                        │   Subscription   │◀────│    Treasury    │
                        └──────────────────┘     └─────────────────┘
```

---

## Escrow Contract

Manages secure payment holding with milestone-based releases.

### Contract Interface

**Source**: `src/escrow.rs`

```rust
#[contract]
pub struct EscrowContract;

impl EscrowContract {
    pub fn deposit(env: Env, from: Address, amount: i128);
    pub fn release(env: Env, to: Address, amount: i128);
}
```

### Functions

#### `deposit`

Deposits funds into the escrow contract.

```rust
pub fn deposit(env: Env, from: Address, amount: i128)
```

**Parameters:**
- `env` - Soroban environment
- `from` - Sender address ( Address type)
- `amount` - Amount to deposit (i128)

**Workflow:**
1. Validates sender is authorized
2. Transfers tokens from sender to escrow
3. Updates escrow balance state

#### `release`

Releases funds to recipient based on milestone completion.

```rust
pub fn release(env: Env, to: Address, amount: i128)
```

**Parameters:**
- `env` - Soroban environment
- `to` - Recipient address
- `amount` - Amount to release

**Workflow:**
1. Verifies milestone conditions met
2. Releases funds to recipient
3. Updates remaining escrow balance

---

## Subscription Contract

Handles recurring subscription payments.

### Contract Interface

**Source**: `src/subscription.rs`

```rust
#[contract]
pub struct SubscriptionContract;

impl SubscriptionContract {
    pub fn subscribe(env: Env, subscriber: Address, plan_id: i128);
    pub fn cancel(env: Env, subscriber: Address);
}
```

### Functions

#### `subscribe`

Creates a new subscription.

```rust
pub fn subscribe(env: Env, subscriber: Address, plan_id: i128)
```

**Parameters:**
- `env` - Soroban environment
- `subscriber` - Subscriber address
- `plan_id` - Subscription plan ID

**Subscription Plans:**

| Plan ID | Description | Amount |
|--------|-------------|--------|
| 1 | Basic | 10 USDC/month |
| 2 | Pro | 50 USDC/month |
| 3 | Enterprise | 500 USDC/month |

#### `cancel`

Cancels an existing subscription.

```rust
pub fn cancel(env: Env, subscriber: Address)
```

**Parameters:**
- `env` - Soroban environment
- `subscriber` - Subscriber address

---

## Payment Intent Contract

Manages payment lifecycle from creation to completion.

### Contract Interface

**Source**: `src/payment_intent.rs`

```rust
#[contract]
pub struct PaymentIntentContract;

impl PaymentIntentContract {
    pub fn create_intent(env: Env, from: Address, to: Address, amount: i128);
    pub fn capture_payment(env: Env, intent_id: Symbol);
}
```

### Functions

#### `create_intent`

Creates a new payment intent.

```rust
pub fn create_intent(env: Env, from: Address, to: Address, amount: i128)
```

**Parameters:**
- `env` - Soroban environment
- `from` - Payer address
- `to` - Payee address
- `amount` - Payment amount

**Returns:** `Symbol` - Unique intent ID

#### `capture_payment`

Captures a payment after funds are received on-chain.

```rust
pub fn capture_payment(env: Env, intent_id: Symbol)
```

**Parameters:**
- `env` - Soroban environment
- `intent_id` - Payment intent ID (Symbol)

---

## State Machines

### Escrow State Machine

```
    ┌─────────────┐
    │  CREATED   │
    └─────┬──────┘
          │ deposit()
          ▼
    ┌─────────────┐
    │  FUNDED    │─────── release()
    └─────┬──────┘         │
          │                 ▼
          │           ┌─────────────┐
          └──────────▶│  RELEASED  │
                     └─────────────┘
```

**States:**
- `CREATED` - Escrow initialized, no funds deposited
- `FUNDS` - Funds deposited, awaiting release
- `RELEASED` - Milestone completed, funds released

### Payment Intent State Machine

```
    ┌─────────────┐
    │  PENDING   │
    └─────┬──────┘
          │ on-chain payment
          ▼
    ┌─────────────┐
    │  PENDING   │────── capture_payment()
    └─────┬──────┘         │
          │                 ▼
          │           ┌─────────────┐
          └──────────▶│ COMPLETED  │
                     └─────────────┘
```

**States:**
- `PENDING` - Payment intent created, awaiting on-chain payment
- `CONFIRMED` - On-chain payment detected
- `COMPLETED` - Payment captured and processed
- `FAILED` - Payment failed or expired

### Subscription State Machine

```
    ┌─────────────┐
    │  ACTIVE    │
    └─────┬──────┘
          │ cancel()
          ▼                  payment_due()
    ┌─────────────┐ ◀─────────────────────┐
    │ CANCELLED   │                       │
    └───────────┘                       ▼
                              ┌─────────────────┐
                              │  PAYMENT_DUE    │
                              └────────┬────────┘
                                       │ payment_received()
                                       ▼
                                  ┌──────────┘
                                  │  ACTIVE
                                  └──────────┘
```

**States:**
- `ACTIVE` - subscription active
- `PAYMENT_DUE` - Recurring payment due
- `CANCELLED` - Subscription cancelled

---

## Integration Examples

### Rust SDK Usage

```rust
use soroban_sdk::{Env, Address};

// Initialize escrow
let env = Env::default();
let escrow = EscrowContractClient::new(&env, &escrow_address);

// Deposit funds
escrow.deposit(&from_address, &10_0000000); // 10 USDC

// Release funds (after milestone)
escrow.release(&to_address, &5_0000000); // 5 USDC
```

### Payment Flow Integration

```rust
// 1. Create payment intent
let intent_id = payment_intent.create_intent(
    &payer,
    &payee,
    &100_0000000, // 100 USDC
);

// 2. Wait for on-chain payment
// (User sends USDC to escrow account)

// 3. Capture payment
payment_intent.capture_payment(&intent_id);

// 4. Release to merchant
escrow.release(&merchant_address, &100_0000000);
```

### Subscription Integration

```rust
// Subscribe to a plan
subscription.subscribe(&subscriber_address, &2); // Plan ID 2 - Pro

// Process recurring payment
let payments = subscription.get_pending_payments(&env);
for payment in payments {
    escrow.release(&subscriber_address, &payment.amount);
}

// Cancel subscription
subscription.cancel(&subscriber_address);
```

### JavaScript SDK Integration

```typescript
import { Server } from 'stellar-sdk';

const server = new Server('https://horizon-testnet.stellar.org');

// Interact with escrow contract
const escrow = await server.readContractData(
  escrowAddress,
  'EscrowContract'
);

console.log('Escrow balance:', escrow.balance);
```

---

## Deployment

### Build Contracts

```bash
# Build all contracts
cargo build --workspace

# Build specific contract
cargo build -p escrow
```

### Deploy to Testnet

```bash
# Deploy escrow contract
soroban contract deploy --wasm target/wasm32-unknown-unknown/release/escrow.wasm

# Deploy subscription contract
soroban contract deploy --wasm target/wasm32-unknown-unknown/release/subscription.wasm

# Deploy payment intent contract
soroban contract deploy --wasm target/wasm32-unknown-unknown/release/payment_intent.wasm
```

### Contract Addresses (Testnet)

| Contract | Address |
|----------|---------|
| Escrow | `CBQY...` (TBD) |
| Subscription | `CBQY...` (TBD) |
| Payment Intent | `CBQY...` (TBD) |

---

## Security Considerations

1. **Access Control**: Only authorized addresses can call deposit/release
2. **Reentrancy**: Guards prevent reentrant calls
3. **Overflow**: All arithmetic uses i128 to prevent overflow
4. **Validation**: Input validation on all public functions

---

## License

MIT