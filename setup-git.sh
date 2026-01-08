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
echo "🔐 GitHub Authentication Required"
echo ""
echo "GitHub no longer accepts passwords for git operations."
echo "You need to use a Personal Access Token (PAT)."
echo ""
echo "📋 Steps to create a PAT:"
echo "   1. Go to: https://github.com/settings/tokens"
echo "   2. Click 'Generate new token' → 'Generate new token (classic)'"
echo "   3. Give it a name (e.g., 'Whatnot Extension')"
echo "   4. Select scope: check 'repo' (this gives full repository access)"
echo "   5. Click 'Generate token'"
echo "   6. COPY THE TOKEN (you won't see it again!)"
echo ""
echo "💡 When prompted for credentials:"
echo "   - Username: iamjoshmoulton-rt"
echo "   - Password: [paste your Personal Access Token here]"
echo ""
echo "Press Enter to continue..."
read

git push -u origin main

echo ""
echo "✅ Successfully pushed to GitHub!"
echo "   Repository: https://github.com/iamjoshmoulton-rt/wn-this"
