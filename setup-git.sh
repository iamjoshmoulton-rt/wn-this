#!/bin/bash

# Setup script for initializing git and pushing to GitHub
# Run this AFTER accepting the Xcode license with: sudo xcodebuild -license

set -e  # Exit on error

cd "$(dirname "$0")"

echo "🚀 Setting up Git repository..."

# Initialize git if not already done
if [ ! -d .git ]; then
    echo "📦 Initializing git repository..."
    git init
else
    echo "✓ Git repository already initialized"
fi

# Set git config (local to this repo)
echo "⚙️  Configuring git user..."
git config user.name "iamjoshmoulton-rt" || true
git config user.email "iamjoshmoulton-rt@users.noreply.github.com" || true

# Add all files
echo "📝 Staging all files..."
git add .

# Check if we have any changes to commit
if git diff --staged --quiet; then
    echo "ℹ️  No changes to commit (repository may already be up to date)"
else
    echo "💾 Creating initial commit..."
    git commit -m "Initial commit: Whatnot Pulse Chrome Extension

- Real-time sales monitoring from Whatnot livestreams
- Streamer identification and session management
- Full history retrieval with auto-scroll
- Payment status validation
- DOM-resilient extraction using anchor-based logic
- Context error prevention"
fi

# Add remote if it doesn't exist
if ! git remote get-url origin > /dev/null 2>&1; then
    echo "🔗 Adding GitHub remote..."
    git remote add origin https://github.com/iamjoshmoulton-rt/wn-this.git
else
    echo "✓ Remote already configured"
    git remote set-url origin https://github.com/iamjoshmoulton-rt/wn-this.git
fi

# Set main branch
echo "🌿 Setting main branch..."
git branch -M main

# Push to GitHub
echo "⬆️  Pushing to GitHub..."
echo ""
echo "⚠️  You may be prompted for GitHub credentials."
echo "   If you have 2FA enabled, use a Personal Access Token as your password."
echo ""

git push -u origin main

echo ""
echo "✅ Successfully pushed to GitHub!"
echo "   Repository: https://github.com/iamjoshmoulton-rt/wn-this"
