#!/bin/bash
# Database setup script

set -e

echo "🗄️  Setting up cfw-fileup database..."

cd "$(dirname "$0")/../../packages/app"

# Generate migrations
echo "📝 Generating migrations..."
pnpm db:generate

# Apply migrations to local D1
echo "🚀 Applying migrations to local database..."
npx wrangler d1 migrations apply cfw-fileup-db --local

echo "✅ Database setup complete!"
echo ""
echo "Next steps:"
echo "  1. Start dev server: pnpm --filter app dev"
echo "  2. Test with curl: curl http://localhost:5173/ping"
