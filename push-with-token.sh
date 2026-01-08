#!/bin/bash

# Helper script to push using a Personal Access Token
# This avoids repeated password prompts

cd "$(dirname "$0")"

if [ -z "$1" ]; then
    echo "Usage: ./push-with-token.sh YOUR_PERSONAL_ACCESS_TOKEN"
    echo ""
    echo "To create a token:"
    echo "1. Go to: https://github.com/settings/tokens"
    echo "2. Generate new token (classic)"
    echo "3. Check 'repo' scope"
    echo "4. Copy the token and use it here"
    exit 1
fi

TOKEN="$1"

# Extract the repo name and owner from the remote URL
REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "https://github.com/iamjoshmoulton-rt/wn-this.git")

# Replace https:// with https://TOKEN@
# This embeds the token in the URL for this push
if [[ "$REMOTE_URL" == https://* ]]; then
    # Remove https:// prefix
    REPO_PATH="${REMOTE_URL#https://}"
    # Add token
    AUTH_URL="https://${TOKEN}@${REPO_PATH}"
    
    echo "🔐 Pushing with Personal Access Token..."
    git push "$AUTH_URL" main
    
    echo ""
    echo "✅ Push complete!"
    echo ""
    echo "⚠️  Note: For security, consider using git credential helper instead:"
    echo "   git config --global credential.helper osxkeychain"
    echo "   Then enter token once when prompted (it will be saved)"
else
    echo "Error: Remote URL format not recognized: $REMOTE_URL"
    exit 1
fi
