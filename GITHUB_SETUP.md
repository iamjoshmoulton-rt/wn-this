# GitHub Setup Guide

## Quick Push (One-Time Token Entry)

### Step 1: Create Personal Access Token
1. Visit: https://github.com/settings/tokens
2. Click "Generate new token" → "Generate new token (classic)"
3. Name: `Whatnot Extension`
4. Expiration: Choose your preference (90 days, or no expiration)
5. **Select scopes**: Check `repo` (gives full repository access)
6. Click "Generate token"
7. **COPY THE TOKEN** - you won't see it again!

### Step 2: Configure Git Credential Helper (Recommended)
This saves your token securely so you don't have to enter it every time:

```bash
git config --global credential.helper osxkeychain
```

### Step 3: Push to GitHub
```bash
git push -u origin main
```

When prompted:
- **Username**: `iamjoshmoulton-rt`
- **Password**: Paste your Personal Access Token here

The credential helper will save it to macOS Keychain, so you won't be asked again.

---

## Alternative: Use Token in Script

If you prefer not to configure the credential helper, you can use the helper script:

```bash
./push-with-token.sh YOUR_PERSONAL_ACCESS_TOKEN
```

This embeds the token in the URL for this push only.

---

## Troubleshooting

**If you get "Authentication failed":**
- Make sure you copied the entire token (no spaces)
- Verify the token has the `repo` scope checked
- Token might have expired (create a new one)

**If you want to use SSH instead:**
1. Generate SSH key: `ssh-keygen -t ed25519 -C "your_email@example.com"`
2. Add to ssh-agent: `eval "$(ssh-agent -s)" && ssh-add ~/.ssh/id_ed25519`
3. Copy public key: `cat ~/.ssh/id_ed25519.pub`
4. Add to GitHub: https://github.com/settings/keys
5. Update remote: `git remote set-url origin git@github.com:iamjoshmoulton-rt/wn-this.git`
