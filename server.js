const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 3000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const API_SECRET = process.env.API_SECRET || "EB_SYNC_9xA72kLm_2025";
const DEFAULT_GUILD_ID = process.env.GUILD_ID || "1249555313527619654";

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

function getSecret(req) {
  return req.header("x-game-secret") || req.header("X-Game-Secret") || "";
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

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    botReady: client.isReady(),
    guildId: DEFAULT_GUILD_ID,
  });
});

app.post("/sync-rank", async (req, res) => {
  try {
    if (getSecret(req) !== API_SECRET) {
      return res.status(401).json({ ok: false, error: "invalid_secret" });
    }

    if (!client.isReady()) {
      return res.status(503).json({ ok: false, error: "bot_not_ready" });
    }

    const payload = req.body || {};
    const guildId = String(payload.guildId || DEFAULT_GUILD_ID);
    const discordUserId = String(payload.discordUserId || "");
    const faction = String(payload.faction || "").toUpperCase();
    const rank = Number(payload.rank);
    const roleId = getRankRoleId(payload);

    if (!guildId || !discordUserId || !faction || !rank || !roleId) {
      return res.status(400).json({
        ok: false,
        error: "missing_required_data",
        required: ["guildId", "discordUserId", "faction", "rank", "roleId"],
      });
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

    return res.json({
      ok: true,
      discordUserId,
      faction,
      rank,
      roleId,
      removed: rolesToRemove,
    });
  } catch (error) {
    console.error("[sync-rank] erro:", error);
    return res.status(500).json({ ok: false, error: "sync_failed" });
  }
});

app.listen(PORT, () => {
  console.log(`API Roblox/Discord rodando na porta ${PORT}`);
});

if (!DISCORD_TOKEN) {
  console.error("Faltou configurar DISCORD_TOKEN nas variaveis de ambiente.");
  process.exit(1);
}

client.once("ready", () => {
  console.log(`Bot conectado como ${client.user.tag}`);
});

client.login(DISCORD_TOKEN);
