# Ergo Storage Rent Bot

An automated bot for claiming storage rent fees on the Ergo blockchain. This bot identifies boxes that are eligible for storage rent collection (boxes older than 4 years) and creates transactions to claim the rent fees while preserving the original box contents.

## Features

- **Automated Scanning**: Continuously scans the Ergo blockchain for eligible boxes
- **Smart Transaction Building**: Uses Fleet SDK for efficient transaction construction
- **Secure Signing**: Integrates with Ergo AppKit for secure transaction signing
- **Database Tracking**: SQLite database for tracking eligible boxes and transactions
- **Comprehensive Logging**: Structured logging with multiple log levels and categories
- **Safety Features**: Dry-run mode, balance checks, and transaction validation
- **Metrics & Monitoring**: Built-in metrics and status reporting

## Prerequisites

- Node.js 18 or higher
- npm or yarn
- Running Ergo node (local or remote)
- Wallet with sufficient ERG balance for transaction fees

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd SR-bot
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment configuration:
```bash
cp env.example .env
```

4. Edit `.env` file with your configuration:
```bash
# Required: Set your wallet credentials
WALLET_MNEMONIC="your twelve word mnemonic phrase here"
WALLET_PASSWORD="your_wallet_password"

# Optional: Adjust other settings as needed
ERGO_NODE_URL=http://127.0.0.1:9053
NETWORK_TYPE=mainnet
MIN_RENT_THRESHOLD=100000000
```

## Configuration

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `ERGO_NODE_URL` | Ergo node API endpoint | `http://127.0.0.1:9053` | No |
| `NETWORK_TYPE` | Network type (`mainnet` or `testnet`) | `mainnet` | No |
| `WALLET_MNEMONIC` | Wallet mnemonic phrase | - | **Yes** |
| `WALLET_PASSWORD` | Wallet password | - | **Yes** |
| `MIN_RENT_THRESHOLD` | Minimum rent fee to collect (nanoergs) | `100000000` (0.1 ERG) | No |
| `MAX_BOXES_PER_TX` | Maximum boxes per transaction | `50` | No |
| `RENT_FEE_PER_BYTE` | Rent fee per byte (nanoergs) | `1250000` | No |
| `SCAN_INTERVAL` | Scan interval (milliseconds) | `300000` (5 min) | No |
| `LOG_LEVEL` | Logging level | `info` | No |
| `DRY_RUN` | Run without submitting transactions | `false` | No |

### Storage Rent Mechanics

Based on [Ergo's storage rent documentation](https://docs.ergoplatform.com/mining/rent/rent-fees/):

- **Rent Period**: 4 years (1,051,200 blocks)
- **Default Rent Fee**: 1,250,000 nanoergs per byte
- **Average Box Size**: ~105 bytes
- **Typical Rent Fee**: ~0.13 ERG per standard box

## Usage

### Using the Shell Script (Recommended)

The project includes a convenient shell script that handles setup and execution:

```bash
# Start the bot
./run-bot.sh start

# Run in dry-run mode (no actual transactions)
./run-bot.sh dry-run

# Check bot status
./run-bot.sh status

# Run in development mode
./run-bot.sh dev

# Show help
./run-bot.sh help
```

### Using npm Scripts

```bash
# Build the project
npm run build

# Start the bot
npm start

# Run in development mode
npm run dev

# Check status
npm start -- --status

# Show help
npm start -- --help
```

### Command Line Options

- `--status`: Display bot status and metrics
- `--help`: Show help message
- `--dry-run`: Set via environment variable `DRY_RUN=true`

## How It Works

### 1. Box Scanning
- Scans the UTXO set for boxes older than 4 years
- Calculates storage rent fees based on box size
- Filters boxes by minimum rent threshold
- Validates boxes for rent collection eligibility

### 2. Transaction Building
- Groups eligible boxes into batches
- Uses Fleet SDK to construct transactions
- Preserves all box properties except creation info
- Deducts rent fees from box values
- Adds wallet change output to collect rent

### 3. Transaction Signing & Submission
- Signs transactions using Ergo AppKit
- Submits to the Ergo network
- Monitors for confirmation
- Updates database with results

### 4. Database Tracking
- Stores eligible boxes and their status
- Tracks transaction history
- Maintains bot state and metrics
- Provides audit trail

## Database Schema

The bot uses SQLite to track:

- **eligible_boxes**: Discovered boxes and their rent status
- **transactions**: Storage rent claiming transactions
- **bot_state**: Bot configuration and runtime state

See `SR-bot.md` for detailed schema information.

## Logging

Logs are written to the `logs/` directory:

- `sr-bot.log`: General application logs
- `error.log`: Error logs only
- `transactions.log`: Transaction-specific logs
- `exceptions.log`: Uncaught exceptions
- `rejections.log`: Unhandled promise rejections

## Safety Features

### Dry Run Mode
Set `DRY_RUN=true` to test the bot without submitting actual transactions:
```bash
DRY_RUN=true ./run-bot.sh start
```

### Balance Checks
- Validates wallet balance before starting
- Ensures sufficient funds for transaction fees
- Configurable minimum balance threshold

### Transaction Validation
- Validates box eligibility before processing
- Checks for sufficient rent fees
- Ensures minimum box values are maintained

## Monitoring

### Status Command
```bash
./run-bot.sh status
```

Shows:
- Bot running status
- Wallet balance
- Last scan height
- Total boxes processed
- Rent collected
- Transaction success rates

### Metrics
The bot tracks comprehensive metrics:
- Total boxes scanned and claimed
- Total rent collected and fees spent
- Transaction success/failure rates
- Processing times and uptime

## Troubleshooting

### Common Issues

1. **"Wallet not initialized"**
   - Check `WALLET_MNEMONIC` and `WALLET_PASSWORD` in `.env`
   - Ensure mnemonic is valid and password is correct

2. **"Cannot connect to Ergo node"**
   - Verify `ERGO_NODE_URL` is correct
   - Ensure Ergo node is running and accessible
   - Check firewall settings

3. **"Insufficient wallet balance"**
   - Add more ERG to your wallet
   - Adjust `WALLET_BALANCE_THRESHOLD` if needed

4. **"No eligible boxes found"**
   - Normal if no boxes are old enough for rent
   - Check `MIN_RENT_THRESHOLD` setting
   - Verify node is fully synced

### Debug Mode
Set `LOG_LEVEL=debug` for verbose logging:
```bash
LOG_LEVEL=debug ./run-bot.sh start
```

## Development

### Project Structure
```
SR-bot/
├── src/
│   ├── config/          # Configuration management
│   ├── database/        # SQLite database operations
│   ├── services/        # Core business logic
│   ├── types/           # TypeScript type definitions
│   ├── utils/           # Utility functions
│   └── index.ts         # Main entry point
├── data/                # Database files
├── logs/                # Log files
├── dist/                # Compiled JavaScript
└── run-bot.sh           # Shell runner script
```

### Building
```bash
npm run build
```

### Testing
```bash
npm test
```

### Linting
```bash
npm run lint
```

## Security Considerations

- **Never commit `.env` file** - Contains sensitive wallet information
- **Use strong wallet passwords** - Protects your private keys
- **Monitor bot activity** - Check logs and metrics regularly
- **Start with dry-run mode** - Test configuration before live operation
- **Keep software updated** - Update dependencies regularly

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

For issues and questions:
1. Check the troubleshooting section
2. Review the logs in `logs/` directory
3. Open an issue on GitHub
4. Join the Ergo community Discord

## Disclaimer

This software is provided as-is. Users are responsible for:
- Testing thoroughly before production use
- Securing their wallet credentials
- Monitoring bot operation
- Understanding Ergo storage rent mechanics

Use at your own risk. The authors are not responsible for any losses. 