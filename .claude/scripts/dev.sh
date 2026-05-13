#!/bin/bash
# Start dev server

set -e

cd "$(dirname "$0")/../../packages/app"

echo "🚀 Starting dev server..."
echo "Access: http://localhost:5173"
echo ""

pnpm dev
