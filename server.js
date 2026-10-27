const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7 // 10MB file limit
});

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;
const REDIRECT_URI = `${SERVER_URL}/auth/discord/callback`;

// Serve static assets from public folder
app.use(express.static('public'));

// Discord Bot Client Setup
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences
  ]
});

// Cache for channel webhooks
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

// ---------------------------------------------------------------------
// DISCORD OAUTH2 AUTHENTICATION ROUTES
// ---------------------------------------------------------------------
app.get('/auth/discord', (req, res) => {
  const scope = encodeURIComponent('identify guilds guilds.members.read');
  const authUrl = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scope}`;
  res.redirect(authUrl);
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/?error=no_code');

  try {
    // Exchange authorization code for token
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI
      })
    });
    const tokens = await tokenResponse.json();
    if (!tokens.access_token) {
      console.error('Tokens response error:', tokens);
      return res.redirect('/?error=auth_failed');
    }

    // Fetch user profile
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const discordUser = await userResponse.json();

    let serverNick = discordUser.global_name || discordUser.username;
    let roles = [];
    let isDev = false;

    const guild = discordClient.guilds.cache.find(g => g.name.toLowerCase().includes('open con')) || discordClient.guilds.cache.first();
    if (guild) {
      try {
        const member = await guild.members.fetch(discordUser.id);
        if (member) {
          serverNick = member.displayName;
          roles = member.roles.cache.filter(r => r.name !== '@everyone').map(r => ({
            id: r.id,
            name: r.name,
            color: r.hexColor
          }));
          isDev = roles.some(r => 
            r.name.toLowerCase().includes('game developer') || 
            r.name.toLowerCase().includes('leader') || 
            r.name.toLowerCase().includes('owner')
          );
        }
      } catch (err) {
        console.log('Member fetch issue:', err.message);
      }
    }

    const userData = {
      id: discordUser.id,
      username: discordUser.username,
      displayName: serverNick,
      avatar: discordUser.avatar 
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=128`
        : 'https://cdn.discordapp.com/embed/avatars/0.png',
      banner: discordUser.banner 
        ? `https://cdn.discordapp.com/banners/${discordUser.id}/${discordUser.banner}.png?size=512` 
        : null,
      roles: roles,
      isDev: isDev
    };

    const encodedPayload = Buffer.from(JSON.stringify(userData)).toString('base64');
    res.redirect(`/?auth=${encodedPayload}`);
  } catch (error) {
    console.error('OAuth Callback Error:', error);
    res.redirect('/?error=server_error');
  }
});

// ---------------------------------------------------------------------
// MULTIPLAYER GAME SOCKETS
// ---------------------------------------------------------------------
const players = {};

discordClient.once('ready', () => {
  console.log(`🤖 Open Con Bot is online as: ${discordClient.user.tag}`);
  discordClient.user.setPresence({
    activities: [{ name: 'Open Con World | 16-bit Expo', type: ActivityType.Playing }],
    status: 'online'
  });
});

discordClient.on('messageCreate', (message) => {
  if (message.author.bot && message.webhookId == null) return;

  const attachments = message.attachments.map(att => att.url);

  io.emit('discordMessage', {
    author: message.author.username,
    displayName: message.member ? message.member.displayName : message.author.username,
    avatar: message.author.displayAvatarURL({ extension: 'png', size: 64 }),
    channelId: message.channel.id,
    content: message.content,
    attachments: attachments
  });
});

io.on('connection', (socket) => {
  console.log(`🎮 Player joined: ${socket.id}`);

  socket.on('joinGame', (userData) => {
    players[socket.id] = {
      id: socket.id,
      discordId: userData.id || null,
      username: userData.username || 'Hero',
      displayName: userData.displayName || userData.username || 'Hero',
      avatar: userData.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png',
      banner: userData.banner || null,
      roles: userData.roles || [],
      isDev: userData.isDev || false,
      x: 480,
      y: 350,
      direction: 'down',
      isMoving: false,
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

  socket.on('sendGameChat', async (data) => {
    if (!data.channelId) return;
    const player = players[socket.id];
    if (!player) return;

    try {
      const channel = await discordClient.channels.fetch(data.channelId);
      if (!channel || !channel.isTextBased()) return;

      const webhook = await getOrCreateWebhook(channel);
      const mentionPrefix = player.discordId ? `<@${player.discordId}>: ` : '';
      const fullMessage = `${mentionPrefix}${data.message || ''}`;

      const payload = {
        username: player.displayName,
        avatarURL: player.avatar,
        content: fullMessage,
        allowed_mentions: { parse: [] } // SILENT PING
      };

      if (data.fileData && data.fileName) {
        payload.files = [{
          attachment: Buffer.from(data.fileData.split(',')[1], 'base64'),
          name: data.fileName
        }];
      }

      if (webhook) {
        await webhook.send(payload);
      } else {
        await channel.send({ content: `**[${player.displayName}]**: ${data.message}`, allowed_mentions: { parse: [] } });
      }

      io.emit('gameMessage', {
        playerId: socket.id,
        displayName: player.displayName,
        message: data.message,
        room: player.room
      });

    } catch (err) {
      console.error('Error sending chat via webhook:', err);
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
