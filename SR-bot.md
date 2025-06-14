# SR-bot - Ergo Storage Rent Claiming Bot

## Overview

The SR-bot is an automated tool designed to claim storage rent fees on the Ergo blockchain. It identifies boxes that are eligible for storage rent collection (boxes older than 4 years) and creates transactions to claim the rent fees while preserving the original box contents.

## Architecture

### Core Components

1. **Box Scanner** - Identifies eligible boxes for storage rent collection
2. **Transaction Builder** - Uses Fleet SDK to construct storage rent claiming transactions
3. **Transaction Signer** - Uses Ergo AppKit to sign transactions with wallet secrets
4. **Fee Calculator** - Calculates appropriate storage rent fees based on box size
5. **Bot Runner** - Main orchestration logic with error handling and logging

### Technology Stack

- **Fleet SDK** - For transaction building and UTXO management
- **Ergo AppKit** - For wallet integration and transaction signing
- **Node.js** - Runtime environment
- **TypeScript** - Type-safe development

## Storage Rent Mechanics

Based on the Ergo documentation:

### Key Metrics
- **Average Size of a Standard Box**: 105 bytes
- **Storage Rent Fee**: 0.13125 ergs for a standard box
- **Rent Collection Period**: Every 4 years (1,051,200 blocks)
- **Default Rent Fee**: 1,250,000 nanoergs per byte
- **Minimum Box Value**: 360 nanoergs per byte

### Eligibility Criteria
- Box must be at least 4 years old (1,051,200 blocks)
- Box must contain sufficient value to cover rent fees
- Box must not be already spent

### Fee Calculation
```
rentFee = boxSizeInBytes * rentFeePerByte
totalFee = rentFee + transactionFee
```

## Database Schema

### Tables

#### `eligible_boxes`
- `box_id` (TEXT PRIMARY KEY) - Unique box identifier
- `creation_height` (INTEGER) - Block height when box was created
- `current_height` (INTEGER) - Current blockchain height when scanned
- `box_size` (INTEGER) - Size of the box in bytes
- `value` (BIGINT) - Box value in nanoergs
- `rent_fee` (BIGINT) - Calculated rent fee in nanoergs
- `status` (TEXT) - Status: 'pending', 'claimed', 'insufficient_funds', 'error'
- `discovered_at` (TIMESTAMP) - When the box was discovered
- `claimed_at` (TIMESTAMP) - When the rent was claimed (if applicable)
- `tx_id` (TEXT) - Transaction ID of the claiming transaction

#### `transactions`
- `tx_id` (TEXT PRIMARY KEY) - Transaction identifier
- `box_ids` (TEXT) - JSON array of box IDs included in transaction
- `total_rent_collected` (BIGINT) - Total rent fees collected
- `transaction_fee` (BIGINT) - Network transaction fee paid
- `created_at` (TIMESTAMP) - Transaction creation time
- `status` (TEXT) - Status: 'pending', 'confirmed', 'failed'

#### `bot_state`
- `key` (TEXT PRIMARY KEY) - State key
- `value` (TEXT) - State value
- `updated_at` (TIMESTAMP) - Last update time

## Configuration

### Environment Variables (.env)
- `ERGO_NODE_URL` - Ergo node API endpoint
- `WALLET_MNEMONIC` - Wallet mnemonic phrase for signing
- `WALLET_PASSWORD` - Wallet password
- `NETWORK_TYPE` - 'mainnet' or 'testnet'
- `MIN_RENT_THRESHOLD` - Minimum rent fee to collect (in nanoergs)
- `MAX_BOXES_PER_TX` - Maximum boxes to include in single transaction
- `SCAN_INTERVAL` - Interval between scans (in milliseconds)
- `LOG_LEVEL` - Logging level ('debug', 'info', 'warn', 'error')

## Implementation Details

### Transaction Building Process
1. Scan for eligible boxes using node API
2. Filter boxes by rent fee threshold and available funds
3. Group boxes into batches for efficient transaction processing
4. Build transaction using Fleet SDK with proper inputs/outputs
5. Calculate and include appropriate fees
6. Sign transaction using Ergo AppKit
7. Submit to network and monitor confirmation

### Error Handling
- Network connectivity issues
- Insufficient funds for rent collection
- Transaction building failures
- Signing failures
- Node synchronization issues

### Logging
- Structured logging with timestamps
- Separate log files for different components
- Configurable log levels
- Transaction audit trail

## Security Considerations

- Wallet secrets stored in environment variables
- No hardcoded private keys or mnemonics
- Secure handling of transaction signing
- Input validation for all external data
- Rate limiting for API calls

## Monitoring and Maintenance

### Metrics to Track
- Number of eligible boxes discovered
- Total rent fees collected
- Transaction success/failure rates
- Average processing time per transaction
- Network fees paid vs rent collected

### Maintenance Tasks
- Regular database cleanup of old records
- Log file rotation
- Monitoring of wallet balance
- Node connectivity health checks

## Future Enhancements

- Web dashboard for monitoring bot performance
- Multi-wallet support for increased throughput
- Advanced box selection algorithms
- Integration with mining pools for rent sharing
- Automated profit optimization strategies 