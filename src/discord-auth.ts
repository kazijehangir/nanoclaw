#!/usr/bin/env node

/**
 * Discord Bot Authentication
 *
 * This script helps you set up a Discord bot and get the token.
 * Run: npm run discord-auth
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function main() {
  console.log('\n=== Discord Bot Setup ===\n');

  console.log('To create a Discord bot:\n');
  console.log('1. Go to https://discord.com/developers/applications');
  console.log(
    '2. Click "New Application" and give it a name (e.g., "NanoClaw")',
  );
  console.log('3. Go to the "Bot" tab and click "Add Bot"');
  console.log('4. Under "Privileged Gateway Intents", enable:');
  console.log('   - MESSAGE CONTENT INTENT (required to read messages)');
  console.log('   - SERVER MEMBERS INTENT (optional, for member info)');
  console.log('5. Click "Reset Token" and copy the token\n');
  console.log('6. To invite the bot to your server:');
  console.log('   - Go to "OAuth2" → "URL Generator"');
  console.log('   - Select scopes: "bot"');
  console.log(
    '   - Select permissions: "Send Messages", "Read Messages/View Channels"',
  );
  console.log('   - Copy the generated URL and open it in your browser\n');

  const token = await question('Paste your Discord bot token: ');

  if (!token || !token.trim()) {
    console.error('\nError: No token provided');
    process.exit(1);
  }

  const trimmedToken = token.trim();

  // Validate token format (Discord tokens are typically base64-encoded)
  if (trimmedToken.length < 50) {
    console.error(
      '\nError: Token seems too short. Please check and try again.',
    );
    process.exit(1);
  }

  // Update .env file
  const envPath = path.join(__dirname, '..', '.env');
  let envContent = '';

  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }

  // Remove existing DISCORD_BOT_TOKEN if present
  const lines = envContent
    .split('\n')
    .filter((line) => !line.startsWith('DISCORD_BOT_TOKEN='));

  // Add new token
  lines.push(`DISCORD_BOT_TOKEN=${trimmedToken}`);

  fs.writeFileSync(envPath, lines.join('\n') + '\n');

  console.log('\n✓ Discord bot token saved to .env');
  console.log('\nNext steps:');
  console.log(
    "1. Make sure you've invited the bot to your server (see step 6 above)",
  );
  console.log('2. Run the setup to configure your main channel: npm run setup');
  console.log(
    '3. Or rebuild and restart NanoClaw: npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw\n',
  );

  rl.close();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
