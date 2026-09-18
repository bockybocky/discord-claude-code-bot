import { Client } from 'discord.js';
import fs from 'node:fs';

const token = process.env.DISCORD_TOKEN;
console.log(`Testing token: ${token?.slice(0, 10)}...`);

const client = new Client({ intents: [] });
client.login(token)
  .then(() => {
    console.log('Token is VALID!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Token is INVALID:', err.message);
    process.exit(1);
  });
