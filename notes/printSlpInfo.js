const SlippiGame = require('@slippi/slippi-js').SlippiGame;
//import { SlippiGame } from '@slippi/slippi-js';
const path = require('path');

// Get the Slippi file path from the command line arguments
const slippiFilePath = process.argv[2];

if (!slippiFilePath) {
  console.error('Please provide a Slippi file path as an argument.');
  process.exit(1);
}

// Parse the Slippi replay file
const game = new SlippiGame(slippiFilePath);

// Extract basic game info
const settings = game.getSettings();
const metadata = game.getMetadata();
const stats = game.getStats();

// Print basic info
console.log('Settings:');
console.log(`  Stage: ${settings.stage}`);
console.log('  Players:');
settings.players.forEach((player, index) => {
  console.log(`    Player ${index + 1}:`);
  console.log(`      Character: ${player.characterId}`);
  console.log(`      Port: ${player.port}`);
  console.log(`      Display Name: ${player.displayName}`);
  console.log(`      Connect Code: ${player.connectCode}`);
});

console.log('\nMetadata:');
console.log(`  Start Time: ${metadata.startAt}`);
console.log(`  End Time: ${metadata.endAt}`);
console.log(`  Played On: ${metadata.playedOn}`);

console.log('\nStats:');
console.log(`  Duration (seconds): ${stats.lastFrame / 60}`);