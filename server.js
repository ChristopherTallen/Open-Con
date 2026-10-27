const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7 // Allow up to 10MB file/image uploads
});

const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// Cache for channel webhooks to send messages with custom avatars and names
const webhookCache = {};

async function getOrCreateWebhook(channel) {
  if (webhookCache[channel.id]) return webhookCache[channel.id];
  try {
    const webhooks = await channel.fetchWebhooks();
    let hook = webhooks.find(wh => wh.token);
    if (!hook) {
      hook = await channel.createWebhook({
        name: 'Open Con Bridge',
        reason: 'Bridge for in-game messages'
      });
    }
    webhookCache[channel.id] = hook;
    return hook;
  } catch (err) {
    console.error('Webhook error:', err);
    return null;
  }
}

const players = {};

discordClient.once('ready', () => {
  console.log(`🤖 Open Con Bot is online as: ${discordClient.user.tag}`);
  
  // Set explicit Online status with playing activity
  discordClient.user.setPresence({
    activities: [{ name: 'Open Con World | Stardew Edition', type: ActivityType.Playing }],
    status: 'online'
  });
});

// DISCORD -> GAME: Relay messages to the web world
discordClient.on('messageCreate', (message) => {
  if (message.author.bot && message.webhookId == null) return;

  const attachments = message.attachments.map(att => att.url);

  io.emit('discordMessage', {
    author: message.author.username,
    avatar: message.author.displayAvatarURL({ extension: 'png', size: 64 }),
    channelId: message.channel.id,
    content: message.content,
    attachments: attachments
  });
});

// GAME CLIENTS (Socket.IO)
io.on('connection', (socket) => {
  console.log(`🎮 Player connected: ${socket.id}`);

  socket.on('joinGame', (userData) => {
    players[socket.id] = {
      id: socket.id,
      username: userData.username || 'Traveler',
      avatarUrl: userData.avatarUrl || 'https://cdn.discordapp.com/embed/avatars/0.png',
      x: 450,
      y: 350,
      direction: 'down',
      isMoving: false,
      color: userData.color || '#4b9cd3',
      room: 'lobby'
    };

    socket.emit('currentPlayers', players);
    socket.broadcast.emit('newPlayer', players[socket.id]);
  });

  socket.on('playerMovement', (data) => {
    if (players[socket.id]) {
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
      players[socket.id].direction = data.direction;
      players[socket.id].isMoving = data.isMoving;
      players[socket.id].room = data.room;
      socket.broadcast.emit('playerMoved', players[socket.id]);
    }
  });

  // GAME -> DISCORD: Webhook dispatcher (appears as user's own name and avatar!)
  socket.on('sendGameChat', async (data) => {
    if (!data.channelId) return;

    try {
      const channel = await discordClient.channels.fetch(data.channelId);
      if (!channel || !channel.isTextBased()) return;

      const webhook = await getOrCreateWebhook(channel);

      const payload = {
        username: data.username || 'In-Game Attendee',
        avatarURL: data.avatarUrl || undefined,
        content: data.message || undefined
      };

      // Support for sending images/files directly from the game
      if (data.fileData && data.fileName) {
        payload.files = [{
          attachment: Buffer.from(data.fileData.split(',')[1], 'base64'),
          name: data.fileName
        }];
      }

      if (webhook) {
        await webhook.send(payload);
      } else {
        // Fallback to normal bot message if webhooks are restricted
        await channel.send(`💬 **[${data.username}]**: ${data.message}`);
      }
    } catch (err) {
      console.error('Error dispatching message:', err);
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`🌐 Open Con Server running on port ${PORT}`);
});

if (process.env.DISCORD_TOKEN) {
  discordClient.login(process.env.DISCORD_TOKEN);
}
