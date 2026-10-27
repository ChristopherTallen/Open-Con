const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve static assets from the "public" folder
app.use(express.static('public'));

// Discord Bot Client Setup
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// Active in-game players cache
const players = {};

// When Discord bot is ready
discordClient.once('ready', () => {
  console.log(`🤖 Open Con Bot is online as: ${discordClient.user.tag}`);
});

// DISCORD -> GAME: Relay messages to the game
discordClient.on('messageCreate', (message) => {
  // Ignore messages sent by bots
  if (message.author.bot) return;

  // Broadcast to all connected web clients
  io.emit('discordMessage', {
    author: message.author.username,
    channelId: message.channel.id,
    content: message.content
  });
});

// GAME CLIENTS HANDLER (Socket.IO)
io.on('connection', (socket) => {
  console.log(`🎮 New player connected: ${socket.id}`);

  // When a player joins the world
  socket.on('joinGame', (userData) => {
    players[socket.id] = {
      id: socket.id,
      username: userData.username || 'Attendee',
      x: 400,
      y: 300,
      room: 'lobby'
    };

    // Send the current world state to the new player
    socket.emit('currentPlayers', players);
    // Broadcast the new player arrival to others
    socket.broadcast.emit('newPlayer', players[socket.id]);
  });

  // When a player moves on the map
  socket.on('playerMovement', (movementData) => {
    if (players[socket.id]) {
      players[socket.id].x = movementData.x;
      players[socket.id].y = movementData.y;
      players[socket.id].room = movementData.room;
      socket.broadcast.emit('playerMoved', players[socket.id]);
    }
  });

  // GAME -> DISCORD: When a player types in the in-game chat
  socket.on('sendGameChat', async (data) => {
    if (data.channelId && data.message) {
      try {
        const channel = await discordClient.channels.fetch(data.channelId);
        if (channel && channel.isTextBased()) {
          await channel.send(`💬 **[${data.username} in-game]**: ${data.message}`);
        }
      } catch (err) {
        console.error('Error forwarding message to Discord:', err);
      }
    }
  });

  // Handle client disconnection
  socket.on('disconnect', () => {
    console.log(`❌ Player disconnected: ${socket.id}`);
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id);
  });
});

// Start web server
server.listen(PORT, () => {
  console.log(`🌐 Open Con Server running on port ${PORT}`);
});

// Log in the Discord bot if token is present
if (process.env.DISCORD_TOKEN) {
  discordClient.login(process.env.DISCORD_TOKEN);
} else {
  console.log('⚠️ DISCORD_TOKEN is not configured yet.');
}
