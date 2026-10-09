const {
  Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder,
  REST, Routes, PermissionFlagsBits, Collection
} = require('discord.js');
const Database = require('better-sqlite3');
const path = require('path');

// --- Config ---
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const REWARD = 0.15; // $ par parrainage

// --- DB ---
const db = new Database(path.join(__dirname, 'parrainage.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inviter_id TEXT NOT NULL,
    inviter_name TEXT NOT NULL,
    invited_id TEXT NOT NULL,
    invited_name TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    week TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS config (
    guild_id TEXT PRIMARY KEY,
    log_channel_id TEXT
  );
`);

const stmts = {
  addReferral: db.prepare(`INSERT INTO referrals (inviter_id, inviter_name, invited_id, invited_name, guild_id, week) VALUES (?, ?, ?, ?, ?, ?)`),
  weekTotal: db.prepare(`SELECT SUM(1) as count FROM referrals WHERE inviter_id = ? AND guild_id = ? AND week = ?`),
  leaderboard: db.prepare(`SELECT inviter_id, inviter_name, COUNT(*) as count FROM referrals WHERE guild_id = ? AND week = ? GROUP BY inviter_id ORDER BY count DESC LIMIT 15`),
  allTimeLeaderboard: db.prepare(`SELECT inviter_id, inviter_name, COUNT(*) as count FROM referrals WHERE guild_id = ? GROUP BY inviter_id ORDER BY count DESC LIMIT 15`),
  setLogChannel: db.prepare(`INSERT OR REPLACE INTO config (guild_id, log_channel_id) VALUES (?, ?)`),
  getLogChannel: db.prepare(`SELECT log_channel_id FROM config WHERE guild_id = ?`),
  alreadyTracked: db.prepare(`SELECT 1 FROM referrals WHERE invited_id = ? AND guild_id = ?`),
};

function currentWeek() {
  const now = new Date();
  // ISO week: Monday-based
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// --- Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
  ],
});

// Cache invites per guild: Map<guildId, Map<inviteCode, uses>>
const inviteCache = new Collection();

// --- Events ---

client.once('ready', async () => {
  console.log(`Bot connecté: ${client.user.tag}`);

  // Cache all existing invites
  for (const guild of client.guilds.cache.values()) {
    try {
      const invites = await guild.invites.fetch();
      inviteCache.set(guild.id, new Collection(invites.map(i => [i.code, i.uses])));
    } catch (e) {
      console.log(`Impossible de fetch les invites pour ${guild.name}: ${e.message}`);
    }
  }

  // Register slash commands
  await registerCommands();
});

// Update cache when a new invite is created
client.on('inviteCreate', (invite) => {
  const guildInvites = inviteCache.get(invite.guild.id) || new Collection();
  guildInvites.set(invite.code, invite.uses);
  inviteCache.set(invite.guild.id, guildInvites);
});

// Remove from cache when invite is deleted
client.on('inviteDelete', (invite) => {
  const guildInvites = inviteCache.get(invite.guild.id);
  if (guildInvites) guildInvites.delete(invite.code);
});

// Main logic: detect who invited the new member
client.on('guildMemberAdd', async (member) => {
  const { guild } = member;

  // Skip bots
  if (member.user.bot) return;

  // Check if already tracked (prevent duplicates)
  if (stmts.alreadyTracked.get(member.id, guild.id)) return;

  try {
    // Fetch current invites
    const newInvites = await guild.invites.fetch();
    const oldInvites = inviteCache.get(guild.id) || new Collection();

    // Find the invite that got +1 use
    const usedInvite = newInvites.find(i => {
      const oldUses = oldInvites.get(i.code) || 0;
      return i.uses > oldUses;
    });

    // Update cache
    inviteCache.set(guild.id, new Collection(newInvites.map(i => [i.code, i.uses])));

    if (!usedInvite || !usedInvite.inviter) return;

    const inviter = usedInvite.inviter;

    // Don't count self-invites
    if (inviter.id === member.id) return;

    // Save to DB
    const week = currentWeek();
    stmts.addReferral.run(inviter.id, inviter.displayName || inviter.username, member.id, member.displayName || member.user.username, guild.id, week);

    // Get weekly total for the inviter
    const row = stmts.weekTotal.get(inviter.id, guild.id, week);
    const weekCount = row?.count || 1;
    const weekTotal = (weekCount * REWARD).toFixed(2);

    // Post in log channel
    const config = stmts.getLogChannel.get(guild.id);
    if (!config?.log_channel_id) return;

    const logChannel = guild.channels.cache.get(config.log_channel_id);
    if (!logChannel) return;

    // Get inviter's role (highest non-@everyone)
    let inviterRole = '';
    try {
      const inviterMember = await guild.members.fetch(inviter.id);
      const topRole = inviterMember.roles.cache
        .filter(r => r.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .first();
      if (topRole) inviterRole = topRole.name.toUpperCase() + ' ';
    } catch (_) {}

    await logChannel.send(
      `**${member.displayName || member.user.username}** a été parrainé par **${inviterRole}${inviter.displayName || inviter.username}** — +${REWARD.toFixed(2)}$ pour lui 💸\nTotal pour cette semaine : **${weekTotal}$**`
    );

  } catch (e) {
    console.error('Erreur guildMemberAdd:', e);
  }
});

// --- Slash Commands ---

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('setup-parrainage')
      .setDescription('Configure le salon de log des parrainages')
      .addChannelOption(o => o.setName('salon').setDescription('Salon où poster les parrainages').setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Classement des parrains cette semaine'),
    new SlashCommandBuilder()
      .setName('leaderboard-all')
      .setDescription('Classement des parrains (tout temps)'),
    new SlashCommandBuilder()
      .setName('parrainage-embed')
      .setDescription('Envoie l\'embed du programme de parrainage')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('mes-parrainages')
      .setDescription('Voir tes parrainages de la semaine'),
  ];

  const rest = new REST().setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), {
      body: commands.map(c => c.toJSON()),
    });
    console.log('Commandes slash enregistrées.');
  } catch (e) {
    console.error('Erreur enregistrement commandes:', e);
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guild } = interaction;

  if (commandName === 'setup-parrainage') {
    const channel = interaction.options.getChannel('salon');
    stmts.setLogChannel.run(guild.id, channel.id);
    await interaction.reply({ content: `✅ Salon de parrainage configuré : ${channel}`, ephemeral: true });
  }

  else if (commandName === 'parrainage-embed') {
    const embed = new EmbedBuilder()
      .setTitle('🎁 Programme de parrainage')
      .setDescription(
        `Invite tes amis à rejoindre en tant que VA ! 🚀\n\n` +
        `**Comment ça marche :**\n` +
        `1️⃣ Tu fais venir tes amis → ils rejoignent et deviennent VA.\n` +
        `2️⃣ Le bot détecte automatiquement ton lien d'invitation.\n` +
        `3️⃣ Tu reçois ta récompense !\n\n` +
        `💰 **1 VA ramené = ${REWARD.toFixed(2)} $**\n` +
        `📅 **Récap + paiement chaque fin de semaine (dimanche).**\n\n` +
        `Plus tu ramènes de VA, plus tu gagnes. 🚀`
      )
      .setColor(0xFFD700);
    await interaction.channel.send({ embeds: [embed] });
    await interaction.reply({ content: '✅ Embed envoyé.', ephemeral: true });
  }

  else if (commandName === 'leaderboard') {
    const week = currentWeek();
    const rows = stmts.leaderboard.all(guild.id, week);
    if (!rows.length) {
      return interaction.reply({ content: 'Aucun parrainage cette semaine.', ephemeral: true });
    }
    const lines = rows.map((r, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      return `${medal} **${r.inviter_name}** — ${r.count} parrainage(s) = **${(r.count * REWARD).toFixed(2)}$**`;
    });
    const embed = new EmbedBuilder()
      .setTitle(`🏆 Classement parrainages — Semaine ${week}`)
      .setDescription(lines.join('\n'))
      .setColor(0x00BFFF);
    await interaction.reply({ embeds: [embed] });
  }

  else if (commandName === 'leaderboard-all') {
    const rows = stmts.allTimeLeaderboard.all(guild.id);
    if (!rows.length) {
      return interaction.reply({ content: 'Aucun parrainage enregistré.', ephemeral: true });
    }
    const lines = rows.map((r, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      return `${medal} **${r.inviter_name}** — ${r.count} parrainage(s) = **${(r.count * REWARD).toFixed(2)}$**`;
    });
    const embed = new EmbedBuilder()
      .setTitle('🏆 Classement parrainages — Tout temps')
      .setDescription(lines.join('\n'))
      .setColor(0x9B59B6);
    await interaction.reply({ embeds: [embed] });
  }

  else if (commandName === 'mes-parrainages') {
    const week = currentWeek();
    const row = stmts.weekTotal.get(interaction.user.id, guild.id, week);
    const count = row?.count || 0;
    await interaction.reply({
      content: `Tu as parrainé **${count}** personne(s) cette semaine = **${(count * REWARD).toFixed(2)}$** 💰`,
      ephemeral: true,
    });
  }
});

// --- Start ---
if (!TOKEN) {
  console.error('DISCORD_TOKEN manquant ! Ajoute-le dans les variables d\'environnement.');
  process.exit(1);
}
if (!CLIENT_ID) {
  console.error('CLIENT_ID manquant ! Ajoute-le dans les variables d\'environnement.');
  process.exit(1);
}

client.login(TOKEN);
