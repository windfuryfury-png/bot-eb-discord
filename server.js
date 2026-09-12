const fs = require("fs");
const path = require("path");
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const app = express();
app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 3000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const API_SECRET = process.env.API_SECRET || "EB_SYNC_9xA72kLm_2025";
const DEFAULT_GUILD_ID = process.env.GUILD_ID || "1249555313527619654";
const LINKS_FILE = path.join(__dirname, "links.json");
const LINK_CODE_TTL_MS = 10 * 60 * 1000;

const EB_ROLE_IDS_BY_RANK = {
  1: "1399583054829457552",
  2: "1399583054141456504",
  3: "1399583053474566204",
  4: "1399583052098830511",
  5: "1399583051067035829",
  6: "399583049821323515",
  7: "1399583047761793127",
  8: "1399583046558285874",
  9: "1399583044310007828",
  10: "1399583043013967954",
  11: "1399583042007466189",
  12: "1399583041659338782",
  13: "1399583040703041700",
  14: "1399583038672998443",
  15: "1399583037594800241",
  16: "1399583036680441886",
  17: "1399583036097560586",
  18: "1399583035074285612",
  19: "1399583033568530442",
  22: "1309028276798492713",
};

const ROLE_IDS_BY_FACTION = {
  EB: EB_ROLE_IDS_BY_RANK,
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

let store = loadStore();

function loadStore() {
  try {
    if (!fs.existsSync(LINKS_FILE)) {
      return { linksByRobloxUserId: {}, pendingByCode: {} };
    }
    return JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
  } catch (error) {
    console.error("[links] erro lendo links.json:", error);
    return { linksByRobloxUserId: {}, pendingByCode: {} };
  }
}

function saveStore() {
  fs.writeFileSync(LINKS_FILE, JSON.stringify(store, null, 2));
}

function getSecret(req) {
  return req.header("x-game-secret") || req.header("X-Game-Secret") || "";
}

function requireSecret(req, res) {
  if (getSecret(req) !== API_SECRET) {
    res.status(401).json({ ok: false, error: "invalid_secret" });
    return false;
  }
  return true;
}

function generateCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function cleanupExpiredCodes() {
  const now = Date.now();
  for (const [code, data] of Object.entries(store.pendingByCode || {})) {
    if (!data.expiresAt || data.expiresAt <= now) {
      delete store.pendingByCode[code];
    }
  }
}

function getFactionRoleIds(faction) {
  return ROLE_IDS_BY_FACTION[String(faction || "").toUpperCase()] || {};
}

function getRankRoleId(payload) {
  if (payload.roleId) {
    return String(payload.roleId);
  }

  const roleIds = getFactionRoleIds(payload.faction);
  return roleIds[Number(payload.rank)] || null;
}

async function syncRank(payload) {
  if (!client.isReady()) {
    return { ok: false, status: 503, error: "bot_not_ready" };
  }

  const guildId = String(payload.guildId || DEFAULT_GUILD_ID);
  const linkedDiscordUserId = store.linksByRobloxUserId[String(payload.robloxUserId)];
  const discordUserId = String(payload.discordUserId || linkedDiscordUserId || "");
  const faction = String(payload.faction || "").toUpperCase();
  const rank = Number(payload.rank);
  const roleId = getRankRoleId(payload);

  if (!guildId || !discordUserId || !faction || !rank || !roleId) {
    return {
      ok: false,
      status: 400,
      error: "missing_required_data",
      required: ["guildId", "discordUserId/link", "faction", "rank", "roleId"],
    };
  }

  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetch(discordUserId);
  const factionRoleIds = Object.values(getFactionRoleIds(faction)).filter(Boolean);
  const rolesToRemove = factionRoleIds.filter((id) => id !== roleId && member.roles.cache.has(id));

  if (rolesToRemove.length > 0) {
    await member.roles.remove(rolesToRemove, "Roblox rank sync");
  }

  if (!member.roles.cache.has(roleId)) {
    await member.roles.add(roleId, "Roblox rank sync");
  }

  console.log(
    `[sync-rank] ${payload.robloxUsername || payload.robloxUserId || discordUserId} -> ${faction} rank ${rank} (${roleId})`
  );

  return {
    ok: true,
    discordUserId,
    faction,
    rank,
    roleId,
    removed: rolesToRemove,
  };
}

async function registerSlashCommands() {
  if (!CLIENT_ID) {
    console.warn("[discord] CLIENT_ID nao configurado; comando /vincular nao sera registrado automaticamente.");
    return;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName("vincular")
      .setDescription("Vincula seu Discord ao perfil do Roblox.")
      .addStringOption((option) =>
        option
          .setName("codigo")
          .setDescription("Codigo mostrado dentro do jogo.")
          .setRequired(true)
      )
      .toJSON(),
  ];

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, DEFAULT_GUILD_ID), { body: commands });
  console.log("[discord] comando /vincular registrado.");
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    botReady: client.isReady(),
    guildId: DEFAULT_GUILD_ID,
    linkedPlayers: Object.keys(store.linksByRobloxUserId || {}).length,
  });
});

app.post("/link/start", (req, res) => {
  if (!requireSecret(req, res)) return;

  cleanupExpiredCodes();
  const robloxUserId = String(req.body?.robloxUserId || "");
  const robloxUsername = String(req.body?.robloxUsername || "");

  if (!robloxUserId) {
    return res.status(400).json({ ok: false, error: "missing_roblox_user_id" });
  }

  if (store.linksByRobloxUserId[robloxUserId]) {
    return res.json({
      ok: true,
      alreadyLinked: true,
      discordUserId: store.linksByRobloxUserId[robloxUserId],
    });
  }

  let code = generateCode();
  while (store.pendingByCode[code]) {
    code = generateCode();
  }

  store.pendingByCode[code] = {
    robloxUserId,
    robloxUsername,
    createdAt: Date.now(),
    expiresAt: Date.now() + LINK_CODE_TTL_MS,
  };
  saveStore();

  return res.json({
    ok: true,
    code,
    expiresInSeconds: Math.floor(LINK_CODE_TTL_MS / 1000),
  });
});

app.post("/link/status", (req, res) => {
  if (!requireSecret(req, res)) return;

  cleanupExpiredCodes();
  const robloxUserId = String(req.body?.robloxUserId || "");
  const discordUserId = store.linksByRobloxUserId[robloxUserId];

  return res.json({
    ok: true,
    linked: Boolean(discordUserId),
    discordUserId: discordUserId || null,
  });
});

app.post("/sync-rank", async (req, res) => {
  try {
    if (!requireSecret(req, res)) return;
    const result = await syncRank(req.body || {});
    return res.status(result.status || 200).json(result);
  } catch (error) {
    console.error("[sync-rank] erro:", error);
    return res.status(500).json({ ok: false, error: "sync_failed" });
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "vincular") {
    return;
  }

  cleanupExpiredCodes();
  const code = interaction.options.getString("codigo", true).trim().toUpperCase();
  const pending = store.pendingByCode[code];

  if (!pending) {
    await interaction.reply({
      content: "Codigo invalido ou expirado. Gere outro codigo dentro do jogo.",
      ephemeral: true,
    });
    return;
  }

  store.linksByRobloxUserId[pending.robloxUserId] = interaction.user.id;
  delete store.pendingByCode[code];
  saveStore();

  await interaction.reply({
    content: `Vinculado com sucesso ao Roblox ${pending.robloxUsername || pending.robloxUserId}.`,
    ephemeral: true,
  });

  console.log(`[link] Roblox ${pending.robloxUserId} vinculado ao Discord ${interaction.user.id}`);
});

app.listen(PORT, () => {
  console.log(`API Roblox/Discord rodando na porta ${PORT}`);
});

if (!DISCORD_TOKEN) {
  console.error("Faltou configurar DISCORD_TOKEN nas variaveis de ambiente.");
  process.exit(1);
}

client.once("clientReady", async () => {
  console.log(`Bot conectado como ${client.user.tag}`);
  try {
    await registerSlashCommands();
  } catch (error) {
    console.error("[discord] erro registrando comandos:", error);
  }
});

client.login(DISCORD_TOKEN);
