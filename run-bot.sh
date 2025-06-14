#!/bin/bash

# SR-bot Runner Script
# Usage: ./run-bot.sh [start|dry-run|status|dev|build|install]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[SR-bot]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SR-bot]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[SR-bot]${NC} $1"
}

print_error() {
    echo -e "${RED}[SR-bot]${NC} $1"
}

# Check if Node.js is installed
check_node() {
    if ! command -v node &> /dev/null; then
        print_error "Node.js is not installed. Please install Node.js 18+ to continue."
        exit 1
    fi
    
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        print_error "Node.js version 18+ is required. Current version: $(node -v)"
        exit 1
    fi
    
    print_success "Node.js version: $(node -v)"
}

# Check if npm is installed
check_npm() {
    if ! command -v npm &> /dev/null; then
        print_error "npm is not installed. Please install npm to continue."
        exit 1
    fi
    print_success "npm version: $(npm -v)"
}

# Create necessary directories
create_directories() {
    print_status "Creating necessary directories..."
    mkdir -p data
    mkdir -p logs
    print_success "Directories created successfully"
}

# Check if .env file exists
check_env() {
    if [ ! -f .env ]; then
        print_warning ".env file not found. Creating from .env.example..."
        if [ -f .env.example ]; then
            cp .env.example .env
            print_warning "Please edit .env file with your configuration before running the bot"
            print_warning "Required: WALLET_MNEMONIC, WALLET_PASSWORD, ERGO_NODE_URL"
            exit 1
        else
            print_error ".env.example file not found. Cannot create .env file."
            exit 1
        fi
    fi
    print_success ".env file found"
}

# Install dependencies
install_deps() {
    print_status "Installing dependencies..."
    npm install
    print_success "Dependencies installed successfully"
}

# Build the project
build_project() {
    print_status "Building project..."
    npm run build
    print_success "Project built successfully"
}

# Run pre-flight checks
preflight_checks() {
    print_status "Running pre-flight checks..."
    check_node
    check_npm
    create_directories
    check_env
    
    if [ ! -d "node_modules" ]; then
        install_deps
    fi
    
    if [ ! -d "dist" ]; then
        build_project
    fi
    
    print_success "Pre-flight checks completed"
}

# Show help
show_help() {
    echo "SR-bot - Ergo Storage Rent Claiming Bot"
    echo ""
    echo "Usage: $0 [COMMAND]"
    echo ""
    echo "Commands:"
    echo "  start     Start the bot in normal mode"
    echo "  dry-run   Run the bot in dry-run mode (no actual transactions)"
    echo "  status    Show bot status and metrics"
    echo "  dev       Run in development mode with hot reload"
    echo "  build     Build the TypeScript project"
    echo "  install   Install dependencies"
    echo "  help      Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 start"
    echo "  $0 dry-run"
    echo "  $0 status"
    echo ""
}

# Main execution
case "${1:-help}" in
    "start")
        print_status "Starting SR-bot in normal mode..."
        preflight_checks
        NODE_ENV=production npm start
        ;;
    "dry-run")
        print_status "Starting SR-bot in dry-run mode..."
        preflight_checks
        print_warning "Running in DRY-RUN mode - no actual transactions will be made"
        NODE_ENV=dry-run npm run dry-run
        ;;
    "status")
        print_status "Checking SR-bot status..."
        preflight_checks
        NODE_ENV=status npm run status
        ;;
    "dev")
        print_status "Starting SR-bot in development mode..."
        preflight_checks
        NODE_ENV=development npm run dev
        ;;
    "build")
        print_status "Building SR-bot..."
        check_node
        check_npm
        build_project
        ;;
    "install")
        print_status "Installing SR-bot dependencies..."
        check_node
        check_npm
        install_deps
        ;;
    "help"|*)
        show_help
        ;;
esac 