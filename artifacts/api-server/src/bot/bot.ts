import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  AutoModerationRuleKeywordPresetType,
  AutoModerationActionType,
  AutoModerationRuleTriggerType,
  AuditLogEvent,
  ChannelSelectMenuBuilder,
  AttachmentBuilder,
  type Interaction,
  type Guild,
  type GuildMember,
  type TextChannel,
  type User,
  type CategoryChannel,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type ModalSubmitInteraction,
  type ChatInputCommandInteraction,
  type ChannelSelectMenuInteraction,
  type Message,
  type MessageEditOptions,
  type MessageCreateOptions,
  type ReplyOptions,
} from "discord.js";

import { logger } from "../lib/logger.js";
import {
  OWNER_ID,
  OWNER_IDS,
  CO_OWNER_ROLE_ID,
  REGULAR_CATEGORIES,
  FARM_CATEGORY,
  ALL_CATEGORIES,
  BOT_COLOR,
  SUCCESS_COLOR,
  ERROR_COLOR,
  WARNING_COLOR,
  GOLD_COLOR,
  BUILD_TICKET_ROLE_ID,
  GIVEAWAY_ROLE_ID,
  TICKET_LOG_CHANNEL_ID,
  TRANSCRIPT_CHANNEL_ID,
  MOD_ROLE_IDS,
  STAFF_ROLE_IDS,
  MODLOG_STAFF_ROLE_ID,
  BLACKLISTED_ROLE_ID,
  AUTO_JOIN_ROLE_ID,
  VOUCH_CHANNEL_IDS_LIST,
  VOUCH_CHANNEL_ID_PRIMARY,
  WELCOME_CHANNEL_DEFAULT,
  WELCOME_RULES_CH,
  SKELLY_CATEGORY,
  GENERAL_TICKET_ROLE_ID,
  SKELLY_TICKET_ROLE_ID,
  OWNER_ROLE_ID,
  STAFF_APP_RESPONSES_CHANNEL_ID,
  LEVELUP_CHANNEL_ID,
  SPAM_LOG_CHANNEL_ID,
  MOD_LOG_CHANNEL_ID,
  INVITE_LOG_CHANNEL_ID,
  COUNTING_CHANNEL_ID,
} from "./config.js";
import { storage, type GiveawayEntry, type WarnEntry } from "./storage.js";

const TOKEN = process.env["DISCORD_BOT_TOKEN"];
const DONUTSMP_API_KEY = process.env["DONUTSMP_API_TOKEN"];

const ONLINE_COLOR = 0x57f287;
const OFFLINE_COLOR = 0xed4245;
const CLAIM_HOURS = 12;
const QUICKDROP_CLAIM_MINUTES = 10;
const DOUBLE_CLAIM_MINUTES = 5;
// BLACKLISTED_ROLE_ID, AUTO_JOIN_ROLE_ID, VOUCH_CHANNEL_IDS_LIST, VOUCH_CHANNEL_ID_PRIMARY,
// WELCOME_* — all imported from config.ts

let _client: Client | null = null;

const activeGiveawayTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activeClaimTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activeStaffApplications = new Set<string>();
const pendingPriceConfirms = new Map<string, { price: number; priceStr: string; builderId: string }>();
const activePaymentPolls = new Map<string, { price: number; priceStr: string; baseBalance: number; intervalId: ReturnType<typeof setInterval>; guildId: string; userId: string }>();

// ─── XP / Level system ────────────────────────────────────────────────────────
// Starts easy (level 10 reachable in ~2 hrs), grows steeply after
function xpForNextLevel(level: number): number {
  return Math.floor(20 + level * 5 + level * level * 2);
}
function computeLevel(totalXp: number): { level: number; currentXp: number; neededXp: number } {
  let level = 0;
  let remaining = totalXp;
  while (remaining >= xpForNextLevel(level)) {
    remaining -= xpForNextLevel(level);
    level++;
  }
  return { level, currentXp: remaining, neededXp: xpForNextLevel(level) };
}

function muteDmEmbed(reason: string, duration: string, moderatorTag: string, guildName: string, warnCount?: number): EmbedBuilder {
  let desc = `**You got muted**\n\n**Reason:** ${reason}\n**Duration:** ${duration}\n**Responsible:** ${moderatorTag}`;
  if (warnCount !== undefined) desc += `\n**Warnings:** ${warnCount} / 5. Reaching 5 results in an automatic ban.`;
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setDescription(desc)
    .setFooter({ text: `Sent from ${guildName}` });
}

function unmuteDmEmbed(reason: string, moderatorTag: string, guildName: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setDescription(`**You got unmuted**\n\n**Reason:** ${reason}\n**Responsible:** ${moderatorTag}`)
    .setFooter({ text: `Sent from ${guildName}` });
}

function warnDmEmbed(reason: string, warnCount: number, guildName: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setDescription(`**You have been warned**\n\n**Reason:** ${reason}\n**Warnings:** ${warnCount} / 5. Reaching 5 results in an automatic ban.`)
    .setFooter({ text: `Sent from ${guildName}` });
}

// ─── Spam detection ───────────────────────────────────────────────────────────
const spamTracker    = new Map<string, number[]>();          // userId → timestamps
const spamCooldown   = new Map<string, number>();            // userId → last alert time
const pendingSpamAlerts = new Map<string, {                  // alertId → alert info
  userId: string; guildId: string; channelId: string; snippets: string[];
}>();
const SPAM_ALERT_CD_MS  = 30_000;

// ─── Cross-channel duplicate tracker ─────────────────────────────────────────
// Detects same message/attachment posted across 3+ channels within the window
type CrossEntry = { channelId: string; messageId: string };
const crossChannelTracker = new Map<string, Map<string, CrossEntry[]>>();
// userId → contentKey → list of {channelId, messageId}
const CROSS_CHANNEL_WINDOW_MS = 60_000;
const CROSS_CHANNEL_THRESHOLD = 3;  // delete when posted in this many channels
const VIOLATION_RESET_MS = 24 * 60 * 60 * 1000; // 24h window before violation count resets

function getCrossKey(msg: import("discord.js").Message): string | null {
  const text = msg.content.trim().toLowerCase();
  const attach = msg.attachments.first();
  if (attach) return `attach:${attach.name ?? "file"}:${attach.size}`;
  if (text.length >= 3) return `text:${text}`;
  return null;
}

// ─── Progressive punishment tracker ──────────────────────────────────────────
// Violation counts are persisted to storage (permanent — never expire)

async function applyProgressivePunishment(
  guild: import("discord.js").Guild,
  userId: string,
  reason: string,
  logChannelId: string,
  violationType: string,
  snippet: string,
) {
  const newCount = storage.incrementViolation(userId, VIOLATION_RESET_MS);
  storage.addViolationLogEntry(userId, {
    type: violationType,
    reason,
    snippet: snippet.slice(0, 256),
    timestamp: new Date().toISOString(),
  });

  const member = await guild.members.fetch(userId).catch(() => null);
  const user   = member?.user ?? null;

  // --- Log to unified mod log channel ---
  const logCh = guild.channels.cache.get(logChannelId) as import("discord.js").TextChannel | undefined;
  if (logCh) {
    const colors = [0xffa500, 0xf0a000, 0xe06000, 0xed4245, 0xed4245];
    const embed = new EmbedBuilder()
      .setColor(colors[Math.min(newCount - 1, colors.length - 1)] ?? 0xffa500)
      .setAuthor({ name: violationType, iconURL: guild.iconURL() ?? undefined })
      .setThumbnail(user?.displayAvatarURL() ?? null)
      .addFields(
        { name: "User",    value: `<@${userId}> (\`${user?.username ?? userId}\`)`, inline: true },
        { name: "Offense", value: `#${newCount} (24h window)`,                      inline: true },
        { name: "Reason",  value: reason,                                            inline: false },
        { name: "Content", value: snippet.slice(0, 512) || "(none)",                inline: false },
      )
      .setTimestamp();
    await logCh.send({ embeds: [embed] }).catch(() => {});
  }

  if (!member) return;

  // --- Progressive actions ---
  if (newCount === 1) {
    // 1st: DM warning only
    user?.send({ embeds: [warnDmEmbed(`${reason}. Continuing will result in a mute.`, newCount, guild.name)] }).catch(() => {});
  } else if (newCount === 2) {
    // 2nd: 1 minute timeout
    if (member.moderatable) {
      await member.timeout(60_000, `Auto-punishment (offense #2): ${reason}`).catch(() => {});
    }
    user?.send({ embeds: [muteDmEmbed(reason, "1 minute", "Bluqo's Bot (AutoMod)", guild.name)] }).catch(() => {});
  } else if (newCount === 3) {
    // 3rd: 5 minute timeout
    if (member.moderatable) {
      await member.timeout(5 * 60_000, `Auto-punishment (offense #3): ${reason}`).catch(() => {});
    }
    user?.send({ embeds: [muteDmEmbed(reason, "5 minutes", "Bluqo's Bot (AutoMod)", guild.name)] }).catch(() => {});
  } else if (newCount === 4) {
    // 4th: 30 minute timeout + warn
    if (member.moderatable) {
      await member.timeout(30 * 60_000, `Auto-punishment (offense #4): ${reason}`).catch(() => {});
    }
    const warnEntry: WarnEntry = { userId, reason: `Auto-warn (offense #4): ${reason}`, moderatorId: "BOT", moderatorTag: "Bluqo's Bot", timestamp: new Date().toISOString() };
    const warnCount = storage.addWarn(userId, warnEntry);
    user?.send({ embeds: [muteDmEmbed(`${reason} (Warning ${warnCount}/5)`, "30 minutes", "Bluqo's Bot (AutoMod)", guild.name)] }).catch(() => {});
    if (warnCount >= 5 && member.bannable) {
      await member.ban({ reason: "Auto-ban: 5 warnings" }).catch(() => {});
    }
  } else {
    // 5th+: warn (auto-ban at 5)
    const warnEntry: WarnEntry = { userId, reason: `Auto-warn (offense #${newCount}): ${reason}`, moderatorId: "BOT", moderatorTag: "Bluqo's Bot", timestamp: new Date().toISOString() };
    const warnCount = storage.addWarn(userId, warnEntry);
    user?.send({ embeds: [warnDmEmbed(reason, warnCount, guild.name)] }).catch(() => {});
    if (warnCount >= 5 && member.bannable) {
      await member.ban({ reason: "Auto-ban: 5 warnings" }).catch(() => {});
    }
  }
}

async function fetchVaultBalance(): Promise<number | null> {
  try {
    const headers: Record<string, string> = {};
    if (DONUTSMP_API_KEY) headers["Authorization"] = `Bearer ${DONUTSMP_API_KEY}`;
    const r = await fetch("https://api.donutsmp.net/v1/stats/BluqoYT", { headers });
    const json = (await r.json()) as { status: number; result?: { money: string } };
    logger.debug({ httpStatus: r.status, apiStatus: json.status, money: json.result?.money }, "fetchVaultBalance response");
    if (json.status !== 200 || !json.result) {
      logger.warn({ httpStatus: r.status, apiStatus: json.status }, "fetchVaultBalance: API did not return OK result");
      return null;
    }
    return parseFloat(json.result.money);
  } catch (err) {
    logger.warn({ err }, "fetchVaultBalance: fetch failed");
    return null;
  }
}

function parsePriceInput(input: string): number | null {
  const s = input.replace(/[$,]/g, "").trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([kmb]?)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (m[2] === "k") return Math.round(n * 1_000);
  if (m[2] === "m") return Math.round(n * 1_000_000);
  if (m[2] === "b") return Math.round(n * 1_000_000_000);
  return Math.round(n);
}

function formatPriceDisplay(amount: number, originalInput: string): string {
  const upper = originalInput.replace(/[$,\s]/g, "").toUpperCase();
  if (/^[\d.]+[KMB]$/.test(upper)) return `$${upper}`;
  return `$${fmtNum(amount)}`;
}

function fmtPayAmount(n: number): string {
  const fmt = (v: number) => (v % 1 === 0 ? `${v}` : v.toFixed(2).replace(/\.?0+$/, ""));
  if (n >= 1_000_000_000) return `${fmt(n / 1_000_000_000)}b`;
  if (n >= 1_000_000)     return `${fmt(n / 1_000_000)}m`;
  if (n >= 1_000)         return `${fmt(n / 1_000)}k`;
  return `${n}`;
}

function buildPaymentEmbed(price: number, priceStr: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(SUCCESS_COLOR)
    .setTitle("✅ Price Agreed!")
    .setDescription(
      `Please pay the following **before** the build starts:\n\n` +
      `**💸 Payments**\n` +
      `\`\`\`\n/pay BluqoYT ${fmtPayAmount(price)}\n\`\`\``,
    )
    .addFields({ name: "Total", value: priceStr, inline: true });
}

function startPaymentPoll(channelId: string, guildId: string, userId: string, price: number, priceStr: string, baseBalance: number) {
  stopPaymentPoll(channelId);
  logger.info({ channelId, price, priceStr, baseBalance }, "Payment poll started");
  const intervalId = setInterval(async () => {
    const current = await fetchVaultBalance();
    if (current === null) {
      logger.warn({ channelId }, "Payment poll: fetchVaultBalance returned null, skipping tick");
      return;
    }
    const diff = current - baseBalance;
    logger.info({ channelId, baseBalance, current, diff, price }, "Payment poll tick");
    if (diff >= price - 1) {
      logger.info({ channelId, diff, price }, "Payment detected — stopping poll");
      stopPaymentPoll(channelId);
      const c = _client;
      if (!c) return;
      const ch = c.guilds.cache.get(guildId)?.channels.cache.get(channelId) as TextChannel | undefined;
      if (!ch) return;
      await ch.send({
        content: `<@${userId}>`,
        embeds: [
          new EmbedBuilder()
            .setColor(SUCCESS_COLOR)
            .setTitle("✅ Payment Received!")
            .setDescription(
              `**${priceStr}** has been received by \`BluqoYT\`.\n\n` +
              `Base balance: \`$${fmtNum(baseBalance)}\` → Current: \`$${fmtNum(current)}\`\n\n` +
              `Thank you! Your build will now begin.`,
            )
            .setTimestamp(),
        ],
      }).catch(() => {});
    }
  }, 3_000);
  activePaymentPolls.set(channelId, { price, priceStr, baseBalance, intervalId, guildId, userId });
}

function stopPaymentPoll(channelId: string) {
  const poll = activePaymentPolls.get(channelId);
  if (poll) { clearInterval(poll.intervalId); activePaymentPolls.delete(channelId); }
}

function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return String(n);
}

function fmtPlaytime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}


function ticketTag(n: number) {
  return `#${String(n).padStart(4, "0")}`;
}

// ─── Giveaway Utilities ────────────────────────────────────────────────────

function genGiveawayId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function parseDuration(input: string): number | null {
  const cleaned = input.trim().replace(/\s+/g, "");
  const match = cleaned.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!match || cleaned === "") return null;
  const [, d, h, m, s] = match;
  const ms =
    (parseInt(d ?? "0") * 86400 +
      parseInt(h ?? "0") * 3600 +
      parseInt(m ?? "0") * 60 +
      parseInt(s ?? "0")) *
    1000;
  return ms > 0 ? ms : null;
}

function doublePrize(prize: string): string {
  const match = prize.trim().match(/^(\d+(?:\.\d+)?)\s*([mb])$/i);
  if (!match) return `2x ${prize}`;
  const suffix = match[2].toLowerCase();
  let num = parseFloat(match[1]) * 2;
  let unit = suffix;
  // Normalise: 1000m+ → b
  if (unit === "m" && num >= 1000) {
    num = num / 1000;
    unit = "b";
  }
  const formatted = Number.isInteger(num) ? num.toString() : parseFloat(num.toFixed(2)).toString();
  return `${formatted}${unit}`;
}

function buildGiveawayEmbed(gw: GiveawayEntry): EmbedBuilder {
  const endTs = Math.floor(new Date(gw.endTime).getTime() / 1000);
  const winnerLabel = gw.winnersCount === 1 ? "Winner" : "Winners";
  let desc = `**Ends:** <t:${endTs}:R> (<t:${endTs}:f>)\n`;
  desc += `**${winnerLabel}:** ${gw.winnersCount}\n`;
  desc += `**Entries:** ${gw.entries.length}\n`;
  desc += `**Hosted by:** <@${gw.hostId}>`;
  if (gw.description) desc += `\n\n${gw.description}`;
  const isQuickdrop = gw.type === "quickdrop";
  const isDouble = gw.type === "double";
  const isSimple = gw.type === "simple";
  const footerText = isQuickdrop
    ? `Quickdrop • ID: ${gw.id} • Claim: ${QUICKDROP_CLAIM_MINUTES} min`
    : isDouble
      ? `Giveaway • ID: ${gw.id} • Claim: ${DOUBLE_CLAIM_MINUTES} min`
      : isSimple
        ? `Giveaway (No Claim) • ID: ${gw.id}`
        : `Giveaway • ID: ${gw.id}`;
  return new EmbedBuilder()
    .setColor(isQuickdrop ? 0xff8c00 : 0xf47bff)
    .setTitle(gw.prize)
    .setDescription(desc)
    .setFooter({ text: footerText })
    .setTimestamp(new Date(gw.endTime));
}

function buildGiveawayEndedEmbed(gw: GiveawayEntry): EmbedBuilder {
  const endTs = Math.floor(new Date(gw.endTime).getTime() / 1000);
  const winnersStr =
    gw.winners.length > 0 ? gw.winners.map((id) => `<@${id}>`).join(", ") : "No winners";
  const winnerLabel = gw.winnersCount === 1 ? "Winner" : "Winners";
  let desc = `**${winnerLabel}:** ${winnersStr}\n\n`;
  desc += `**Ended:** <t:${endTs}:R>\n`;
  desc += `**Total Entries:** ${gw.entries.length}\n`;
  desc += `**Hosted by:** <@${gw.hostId}>`;
  if (gw.description) desc += `\n\n${gw.description}`;
  const isQuickdrop = gw.type === "quickdrop";
  const isDouble = gw.type === "double";
  const isSimple = gw.type === "simple";
  const footerText = isQuickdrop
    ? `Quickdrop • ID: ${gw.id} • Claim: ${QUICKDROP_CLAIM_MINUTES} min`
    : isDouble
      ? `Giveaway • ID: ${gw.id} • Claim: ${DOUBLE_CLAIM_MINUTES} min`
      : isSimple
        ? `Giveaway (No Claim) • ID: ${gw.id}`
        : `Giveaway • ID: ${gw.id}`;
  return new EmbedBuilder()
    .setColor(0x747f8d)
    .setTitle(`${gw.prize} - Ended`)
    .setDescription(desc)
    .setFooter({ text: footerText })
    .setTimestamp(new Date(gw.endTime));
}

function scheduleGiveaway(gw: GiveawayEntry) {
  const remaining = new Date(gw.endTime).getTime() - Date.now();
  if (remaining <= 0) {
    void endGiveaway(gw);
    return;
  }
  const timer = setTimeout(() => void endGiveaway(gw), remaining);
  activeGiveawayTimers.set(gw.id, timer);
}

function scheduleClaimExpiry(gw: GiveawayEntry) {
  if (!gw.claimExpiry) return;
  const remaining = new Date(gw.claimExpiry).getTime() - Date.now();
  if (remaining <= 0) {
    void expireGiveawayClaims(gw.id);
    return;
  }
  const timer = setTimeout(() => void expireGiveawayClaims(gw.id), remaining);
  activeClaimTimers.set(gw.id, timer);
}

async function endGiveaway(gw: GiveawayEntry) {
  activeGiveawayTimers.delete(gw.id);
  const client = _client;
  if (!client) return;

  const fresh = storage.getGiveaway(gw.id);
  if (!fresh || fresh.ended) return;

  const guild = client.guilds.cache.get(fresh.guildId);
  if (!guild) return;

  const ch = guild.channels.cache.get(fresh.channelId) as TextChannel | undefined;
  if (!ch) return;

  const shuffled = [...fresh.entries].sort(() => Math.random() - 0.5);
  const winners = shuffled.slice(0, Math.min(fresh.winnersCount, shuffled.length));

  storage.endGiveaway(fresh.id, winners);
  gw = fresh;
  const updatedGw = storage.getGiveaway(gw.id);
  if (!updatedGw) return;

  try {
    const msg = await ch.messages.fetch(gw.messageId);
    await msg.edit({ embeds: [buildGiveawayEndedEmbed(updatedGw)], components: [] });
  } catch {}

  if (winners.length === 0) {
    await ch
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(ERROR_COLOR)
            .setDescription(`Giveaway for **${gw.prize}** ended with no entries.`)
            ,
        ],
        reply: { messageReference: gw.messageId, failIfNotExists: false },
      })
      .catch(() => {});
    return;
  }

  const gwType = updatedGw.type ?? "normal";

  if (gwType === "simple") {
    for (const winnerId of winners) {
      await ch
        .send({
          content: `Congratulations <@${winnerId}>, you won **${gw.prize}**!`,
          reply: { messageReference: gw.messageId, failIfNotExists: false },
        })
        .catch(() => {});
    }
    return;
  }

  const claimMs = updatedGw.type === "quickdrop"
    ? QUICKDROP_CLAIM_MINUTES * 60 * 1000
    : updatedGw.type === "double"
      ? DOUBLE_CLAIM_MINUTES * 60 * 1000
      : CLAIM_HOURS * 60 * 60 * 1000;
  const claimExpiry = new Date(Date.now() + claimMs);
  storage.setClaimExpiry(gw.id, claimExpiry.toISOString());

  for (const winnerId of winners) {
    try {
      const components =
        gwType === "double"
          ? [
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId(`giveaway_claim_${gw.id}_${winnerId}`)
                  .setLabel("Claim")
                  .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                  .setCustomId(`giveaway_double_${gw.id}_${winnerId}`)
                  .setLabel("Double It")
                  .setStyle(ButtonStyle.Danger),
              ),
            ]
          : [
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId(`giveaway_claim_${gw.id}_${winnerId}`)
                  .setLabel("Claim")
                  .setStyle(ButtonStyle.Primary),
              ),
            ];
      const winMsg = await ch.send({
        content: `Congratulations <@${winnerId}>, you won **${gw.prize}**!`,
        components,
        reply: { messageReference: gw.messageId, failIfNotExists: false },
      });
      storage.addWinMessage(gw.id, winnerId, winMsg.id);
    } catch {}
  }

  scheduleClaimExpiry(updatedGw);
}

async function expireGiveawayClaims(giveawayId: string) {
  activeClaimTimers.delete(giveawayId);
  const client = _client;
  if (!client) return;

  const gw = storage.getGiveaway(giveawayId);
  if (!gw) return;

  const guild = client.guilds.cache.get(gw.guildId);
  if (!guild) return;

  const ch = guild.channels.cache.get(gw.channelId) as TextChannel | undefined;
  if (!ch) return;

  for (const [winnerId, msgId] of Object.entries(gw.winMessages ?? {})) {
    if (gw.claimedBy.includes(winnerId)) continue;
    try {
      const msg = await ch.messages.fetch(msgId);
      await msg.edit({
        content: msg.content,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`giveaway_claim_expired`)
              .setLabel("Claim Expired")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true),
          ),
        ],
      });
    } catch {}
  }
}

// ─── Bot Client ────────────────────────────────────────────────────────────

// ── Invite tracker cache: guildId → Map<inviteCode, uses> ────────────────────
const _inviteCache = new Map<string, Map<string, number>>();

async function cacheGuildInvites(guild: import("discord.js").Guild): Promise<void> {
  try {
    const invites = await guild.invites.fetch();
    const m = new Map<string, number>();
    for (const inv of invites.values()) m.set(inv.code, inv.uses ?? 0);
    _inviteCache.set(guild.id, m);
  } catch {}
}

export function createBotClient(): Client | null {
  if (!TOKEN) {
    logger.warn("DISCORD_BOT_TOKEN not set, bot disabled. Set the secret to enable it.");
    return null;
  }
  if (!DONUTSMP_API_KEY) {
    logger.warn("DONUTSMP_API_KEY not set, /stats command will not work.");
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.AutoModerationExecution,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildInvites,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });

  _client = client;

  client.once("ready", async () => {
    logger.info({ tag: client.user?.tag }, "Bot ready");
    await registerCommands(client);
    for (const guild of client.guilds.cache.values()) {
      await setupAutoMod(guild).catch((e) =>
        logger.warn({ err: e, guild: guild.name }, "AutoMod failed"),
      );
    }
    // Cache invites for invite tracker
    for (const guild of client.guilds.cache.values()) {
      await cacheGuildInvites(guild).catch(() => {});
    }

    // Restore timers for active giveaways (and immediately end any that expired while offline)
    for (const gw of storage.getActiveGiveaways()) {
      scheduleGiveaway(gw);
    }

    // For ended giveaways: restore claim expiry timers AND resend any missing claim
    // buttons for winners who never received their message (bot was down when giveaway ended).
    const allGiveaways = Object.values(storage.getData().giveaways ?? {});
    for (const gw of allGiveaways) {
      if (!gw.ended) continue;

      // Restore claim expiry timers
      if (gw.claimExpiry && !activeClaimTimers.has(gw.id)) {
        scheduleClaimExpiry(gw);
      }

      // Resend claim buttons to winners who never got a win message
      // (happens when bot crashed between storage.endGiveaway and the message sends)
      const missingWinners = gw.winners.filter(
        (wId) => !gw.claimedBy.includes(wId) && !gw.winMessages?.[wId],
      );
      if (missingWinners.length === 0) continue;
      // Skip if claim window has already expired
      if (gw.claimExpiry && new Date() > new Date(gw.claimExpiry)) continue;

      const gwType = gw.type ?? "normal";
      if (gwType === "simple") continue; // simple giveaways don't use claim buttons

      const resendGuild = client.guilds.cache.get(gw.guildId);
      if (!resendGuild) continue;
      const resendCh = resendGuild.channels.cache.get(gw.channelId) as TextChannel | undefined;
      if (!resendCh) continue;

      // Ensure a claim expiry exists
      if (!gw.claimExpiry) {
        const claimMs = gwType === "quickdrop"
          ? QUICKDROP_CLAIM_MINUTES * 60 * 1000
          : gwType === "double"
            ? DOUBLE_CLAIM_MINUTES * 60 * 1000
            : CLAIM_HOURS * 60 * 60 * 1000;
        const expiry = new Date(Date.now() + claimMs);
        storage.setClaimExpiry(gw.id, expiry.toISOString());
      }

      for (const winnerId of missingWinners) {
        try {
          const components =
            gwType === "double"
              ? [
                  new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                      .setCustomId(`giveaway_claim_${gw.id}_${winnerId}`)
                      .setLabel("Claim")
                      .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                      .setCustomId(`giveaway_double_${gw.id}_${winnerId}`)
                      .setLabel("Double It")
                      .setStyle(ButtonStyle.Danger),
                  ),
                ]
              : [
                  new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                      .setCustomId(`giveaway_claim_${gw.id}_${winnerId}`)
                      .setLabel("Claim")
                      .setStyle(ButtonStyle.Primary),
                  ),
                ];
          const winMsg = await resendCh.send({
            content: `Congratulations <@${winnerId}>, you won **${gw.prize}**! (Claim button re-sent — bot was offline when the giveaway ended.)`,
            components,
          });
          storage.addWinMessage(gw.id, winnerId, winMsg.id);
        } catch {}
      }

      // Refresh claim expiry timer now that winMessages are set
      const refreshed = storage.getGiveaway(gw.id);
      if (refreshed?.claimExpiry && !activeClaimTimers.has(gw.id)) {
        scheduleClaimExpiry(refreshed);
      }
    }
  });

  client.on("guildCreate", async (guild) => {
    await setupAutoMod(guild).catch(() => {});
  });

  client.on("autoModerationActionExecution", (execution) => {
    void (async () => {
      const { guild, userId, content, matchedContent, ruleTriggerType } = execution;
      if (!userId || userId === client.user?.id) return;
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member || isStaff(member)) return;

      const typeLabel =
        ruleTriggerType === AutoModerationRuleTriggerType.Keyword       ? "Bad Word Detected" :
        ruleTriggerType === AutoModerationRuleTriggerType.KeywordPreset ? "Bad Word Detected" :
        ruleTriggerType === AutoModerationRuleTriggerType.MentionSpam   ? "Mention Spam"      :
        "AutoMod Triggered";

      const reason = typeLabel.replace(/[^ -~]/g, "").trim() || "AutoMod rule violation";

      void applyProgressivePunishment(
        guild,
        userId,
        reason,
        MOD_LOG_CHANNEL_ID,
        typeLabel,
        (matchedContent || content || "").slice(0, 256),
      );
    })();
  });

  client.on("interactionCreate", (i) => {
    handleInteraction(i).catch((e) => logger.error({ err: e }, "Interaction error"));
  });

  // ─── Vouch Channel Format Enforcer ─────────────────────────────────────────
  const VOUCH_CHANNEL_IDS = new Set(VOUCH_CHANNEL_IDS_LIST);
  const VOUCH_CHANNEL_ID = VOUCH_CHANNEL_ID_PRIMARY;
  const VOUCH_REGEX = /^(scam\s*vouch|vouch)\s+<@!?\d+>(\s+\S.*)?$/i;

  // Per-channel sticky repost cooldown
  const stickyBusy = new Set<string>();

  // ─── Welcome Channels ────────────────────────────────────────────────────
  // WELCOME_CHANNEL_DEFAULT, WELCOME_RULES_CH, WELCOME_GIVEAWAY_1/2/3 — imported from config.ts

  client.on("guildMemberAdd", async (member) => {
    // ── Welcome message ──
    const welcomeChannelId = storage.getWelcomeChannelId() || WELCOME_CHANNEL_DEFAULT;
    const ch = member.guild.channels.cache.get(welcomeChannelId) as TextChannel | null;
    if (ch) {
      const embed = new EmbedBuilder()
        .setColor(SUCCESS_COLOR)
        .setAuthor({ name: member.guild.name, iconURL: member.guild.iconURL() ?? undefined })
        .setTitle("Welcome to Bluqo's Bot")
        .setDescription(
          `Welcome to the server! Please read the rules in <#${WELCOME_RULES_CH}> before participating.`,
        )
        .setThumbnail(member.user.displayAvatarURL())
        .setTimestamp();
      await ch.send({ content: `<@${member.id}>`, embeds: [embed] }).catch(() => {});
    }

    // ── Invite tracker ──
    try {
      const cached = _inviteCache.get(member.guild.id);
      const freshInvites = await member.guild.invites.fetch().catch(() => null);
      if (freshInvites) {
        let inviterId: string | null = null;
        if (cached) {
          for (const inv of freshInvites.values()) {
            const cachedUses = cached.get(inv.code) ?? 0;
            if ((inv.uses ?? 0) > cachedUses && inv.inviterId) {
              inviterId = inv.inviterId;
              break;
            }
          }
        }
        // Update cache with latest uses
        const newMap = new Map<string, number>();
        for (const inv of freshInvites.values()) newMap.set(inv.code, inv.uses ?? 0);
        _inviteCache.set(member.guild.id, newMap);

        if (inviterId) {
          const stats = storage.recordInviteJoin(member.id, inviterId);
          const valid = stats.joins - stats.leaves;
          const logCh = member.guild.channels.cache.get(INVITE_LOG_CHANNEL_ID) as TextChannel | null;
          if (logCh) {
            await logCh.send(
              `<@${member.id}> has been invited by <@${inviterId}>. They now have **${valid}** invite${valid === 1 ? "" : "s"}.`
            ).catch(() => {});
          }
        }
      }
    } catch {}
  });

  client.on("guildMemberRemove", async (member) => {
    const result = storage.recordInviteLeave(member.id);
    if (!result) return;
    const { inviterId, valid } = result;
    const logCh = member.guild.channels.cache.get(INVITE_LOG_CHANNEL_ID) as TextChannel | null;
    if (logCh) {
      await logCh.send(
        `<@${member.id}> left the server. <@${inviterId}> now has **${valid}** invite${valid === 1 ? "" : "s"}.`
      ).catch(() => {});
    }
  });

  // AUTO_JOIN_ROLE_ID — imported from config.ts

  client.on("guildMemberUpdate", async (oldMember, newMember) => {
    const wasBoosting = !!oldMember.premiumSince;
    const isBoosting = !!newMember.premiumSince;
    if (!wasBoosting && isBoosting) {
      await newMember.roles.add(AUTO_JOIN_ROLE_ID).catch(() => {});
    }

    // Detect timeout expiry / removal → send unmute DM
    const wasTimedOut = !!oldMember.communicationDisabledUntil;
    const isTimedOut  = !!newMember.communicationDisabledUntil;
    if (wasTimedOut && !isTimedOut) {
      newMember.send({
        embeds: [unmuteDmEmbed("Expired", "Bluqo's Bot", newMember.guild.name)],
      }).catch(() => {});
    }
  });

  // ─── Voice XP ────────────────────────────────────────────────────────────────
  // Awards XP every minute to users who are unmuted, undeafened, and not alone.
  const VOICE_XP_MIN = 2;
  const VOICE_XP_MAX = 5;
  const VOICE_XP_INTERVAL_MS = 60_000;

  // userId → { guildId, channelId } for everyone currently active in voice
  const activeVoiceUsers = new Map<string, { guildId: string; channelId: string }>();

  function isVoiceActive(state: import("discord.js").VoiceState): boolean {
    return (
      !!state.channelId &&
      !state.selfMute &&
      !state.serverMute &&
      !state.selfDeaf &&
      !state.serverDeaf &&
      state.channelId !== state.guild.afkChannelId
    );
  }

  // Seed map from current voice states on ready (handles bot restarts)
  for (const guild of client.guilds.cache.values()) {
    for (const state of guild.voiceStates.cache.values()) {
      if (state.member && !state.member.user.bot && isVoiceActive(state)) {
        activeVoiceUsers.set(state.member.id, { guildId: guild.id, channelId: state.channelId! });
      }
    }
  }

  client.on("voiceStateUpdate", (oldState, newState) => {
    const member = newState.member ?? oldState.member;
    if (!member || member.user.bot) return;

    if (isVoiceActive(newState)) {
      activeVoiceUsers.set(member.id, { guildId: newState.guild.id, channelId: newState.channelId! });
    } else {
      activeVoiceUsers.delete(member.id);
    }
  });

  setInterval(() => {
    void (async () => {
      for (const [userId, { guildId, channelId }] of activeVoiceUsers) {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) { activeVoiceUsers.delete(userId); continue; }

          const channel = guild.channels.cache.get(channelId);
          if (!channel || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)) {
            activeVoiceUsers.delete(userId);
            continue;
          }

          // Re-verify they're still active (not muted/deafened since last tick)
          const voiceState = guild.voiceStates.cache.get(userId);
          if (!voiceState || !isVoiceActive(voiceState)) {
            activeVoiceUsers.delete(userId);
            continue;
          }

          // Must not be alone — at least 2 non-bot members in the channel
          const humanMembers = channel.members.filter((m) => !m.user.bot);
          if (humanMembers.size < 2) continue;

          const gained = Math.floor(Math.random() * (VOICE_XP_MAX - VOICE_XP_MIN + 1)) + VOICE_XP_MIN;
          const entry = storage.getXP(userId);
          const oldLevel = computeLevel(entry.xp).level;
          storage.addXPOnly(userId, gained);
          const newEntry = storage.getXP(userId);
          const newLevel = computeLevel(newEntry.xp).level;

          if (newLevel > oldLevel && newLevel >= 1 && newLevel <= 100) {
            let lvlCh = guild.channels.cache.get(LEVELUP_CHANNEL_ID) as TextChannel | null;
            if (!lvlCh) {
              lvlCh = await guild.channels.fetch(LEVELUP_CHANNEL_ID).catch(() => null) as TextChannel | null;
            }
            if (lvlCh) {
              await lvlCh.send({
                content: `<@${userId}> just leveled up to **Level ${newLevel}**! 🎙️`,
              }).catch((e) => logger.warn({ err: e }, "Voice level-up message failed to send"));
            }
          }
        } catch (err) {
          logger.warn({ err, userId }, "Voice XP tick error");
        }
      }
    })();
  }, VOICE_XP_INTERVAL_MS);

  const XP_COOLDOWN_MS = 60_000;  // 1 message per minute earns XP — prevents spam leveling
  const XP_MIN = 5;
  const XP_MAX = 15;

  // Deduplicate Discord event re-deliveries — key is message ID, clears after 30s
  const _processedMsgIds = new Set<string>();

  client.on("messageCreate", (msg) => {
    if (msg.author.bot) return;
    if (_processedMsgIds.has(msg.id)) return;
    _processedMsgIds.add(msg.id);
    setTimeout(() => _processedMsgIds.delete(msg.id), 30_000);

    // ── Counting channel ─────────────────────────────────────────────────────
    if (msg.channelId === COUNTING_CHANNEL_ID) {
      void (async () => {
        const trimmed = msg.content.trim();
        const num = parseInt(trimmed, 10);

        // Non-number: delete silently, no reset
        if (isNaN(num) || String(num) !== trimmed) {
          await msg.delete().catch(() => {});
          return;
        }

        const state = storage.getCountingState();
        const isSameUser = msg.author.id === state.lastUserId && state.lastUserId !== "";

        if (num === state.current && !isSameUser) {
          // ✅ Correct number
          await msg.react("✅").catch(() => {});
          storage.setCountingState(state.current + 1, msg.author.id);
        } else {
          // ❌ Wrong number or same user twice
          await msg.react("❌").catch(() => {});
          const ruinedAt = state.current - 1;
          storage.setCountingState(1, "");
          if (ruinedAt > 0) {
            await msg.channel.send(
              `<@${msg.author.id}> **RUINED IT AT ${ruinedAt}!!** Next number is \`1\`. Wrong number.`
            ).catch(() => {});
          } else {
            await msg.channel.send(
              `<@${msg.author.id}> Wrong number! Next number is \`1\`.`
            ).catch(() => {});
          }
        }
      })();
      return; // skip all other processing for counting channel messages
    }

    // ── Staff task message tracking ──────────────────────────────────────────
    if (msg.guild && msg.member && isStaff(msg.member as GuildMember)) {
      storage.incrementMessages(msg.author.id);
    }

    // ── XP tracking + level-up announcements ──
    if (msg.guild) {
      void (async () => {
        const now = Date.now();
        const entry = storage.getXP(msg.author.id);
        if (now - entry.lastMessage < XP_COOLDOWN_MS) return;

        // Claim the cooldown slot immediately (synchronous in-memory + disk write)
        // so any concurrent handler for the same user sees it and skips.
        const gained = Math.floor(Math.random() * (XP_MAX - XP_MIN + 1)) + XP_MIN;
        const oldLevel = computeLevel(entry.xp).level;
        storage.addXP(msg.author.id, gained); // saves xp + updates lastMessage
        const newEntry = storage.getXP(msg.author.id);
        const newLevel = computeLevel(newEntry.xp).level;

        if (newLevel > oldLevel && newLevel >= 1 && newLevel <= 100) {
          let lvlCh = msg.guild.channels.cache.get(LEVELUP_CHANNEL_ID) as TextChannel | null;
          if (!lvlCh) {
            lvlCh = await msg.guild.channels.fetch(LEVELUP_CHANNEL_ID).catch(() => null) as TextChannel | null;
          }
          if (lvlCh) {
            await lvlCh.send({
              content: `<@${msg.author.id}> just leveled up to **Level ${newLevel}**!`,
            }).catch((e) => logger.warn({ err: e }, "Level-up message failed to send"));
          } else {
            logger.warn({ channelId: LEVELUP_CHANNEL_ID }, "Level-up channel not found");
          }
        }

        // ── Vouch enforcer (runs for everyone, including owners) ──
        if (VOUCH_CHANNEL_IDS.has(msg.channelId)) {
          if (!VOUCH_REGEX.test(msg.content.trim())) {
            msg.delete().catch(() => {});
            msg.author
              .send(
                `❌ Your message in <#${msg.channelId}> was removed because it didn't follow the correct format.\n\n` +
                `**Correct formats:**\n` +
                `\`vouch @member\`\n` +
                `\`vouch @member reason\`\n` +
                `\`scam vouch @member\`\n` +
                `\`scam vouch @member reason\`\n` +
                `\`scamvouch @member\`\n` +
                `\`scamvouch @member reason\``,
              )
              .catch(() => {});
          }
          return;
        }

        // Owner/co-owner/staff bypass all other automod
        const authorMember = msg.guild.members.cache.get(msg.author.id) as GuildMember | undefined;
        if (authorMember && isStaff(authorMember)) return;

        // ── Prohibited language filter ──
        if (containsBadWord(msg.content)) {
          await msg.delete().catch(() => {});
          void applyProgressivePunishment(
            msg.guild,
            msg.author.id,
            "Used prohibited language",
            MOD_LOG_CHANNEL_ID,
            "🤬 Prohibited Language",
            msg.content.slice(0, 256),
          );
          return;
        }

        // ── Non-GIF link filter (skipped inside ticket channels — tickets allow all links/files) ──
        const isTicketChannel = !!storage.getTicket(msg.channelId);
        if (!isTicketChannel && hasDisallowedLink(msg.content)) {
          await msg.delete().catch(() => {});
          void applyProgressivePunishment(
            msg.guild,
            msg.author.id,
            "Posted a link that isn't a GIF",
            MOD_LOG_CHANNEL_ID,
            "🔗 Disallowed Link",
            msg.content.slice(0, 256),
          );
          return;
        }

        // ── Cross-channel duplicate detection ──
        if (!isStaff(msg.guild.members.cache.get(msg.author.id) as GuildMember)) {
          const crossKey = getCrossKey(msg);
          if (crossKey) {
            let userMap = crossChannelTracker.get(msg.author.id);
            if (!userMap) { userMap = new Map(); crossChannelTracker.set(msg.author.id, userMap); }

            // Expire old entries outside the window
            const existing = (userMap.get(crossKey) ?? []).filter(
              (e) => {
                // We store timestamps separately via the key expiry below; entries without
                // a distinct channel are just accumulated, so prune by window by keeping
                // all entries that were recently added. We piggy-back on now.
                return true; // kept for immediate use; full map purge handled below
              },
            );

            // Only count unique channels
            const uniqueChannels = new Set(existing.map((e) => e.channelId));
            if (!uniqueChannels.has(msg.channelId)) {
              existing.push({ channelId: msg.channelId, messageId: msg.id });
              userMap.set(crossKey, existing);
            }

            if (existing.length >= CROSS_CHANNEL_THRESHOLD) {
              // Delete all copies across every channel
              for (const entry of existing) {
                if (entry.channelId === msg.channelId) {
                  await msg.delete().catch(() => {});
                } else {
                  const ch = msg.guild.channels.cache.get(entry.channelId) as TextChannel | null;
                  if (ch) {
                    await ch.messages.fetch(entry.messageId).then((m) => m.delete()).catch(() => {});
                  }
                }
              }
              userMap.delete(crossKey);

              void applyProgressivePunishment(
                msg.guild,
                msg.author.id,
                "Cross-channel spam (same message/image in 3+ channels)",
                MOD_LOG_CHANNEL_ID,
                "🔁 Cross-Channel Spam",
                crossKey.startsWith("text:") ? crossKey.slice(5).slice(0, 256) : `[attachment: ${crossKey.slice(7)}]`,
              );

              // Auto-purge the user's entire map after the window so memory doesn't build up
              setTimeout(() => {
                crossChannelTracker.get(msg.author.id)?.delete(crossKey);
              }, CROSS_CHANNEL_WINDOW_MS);
            } else {
              // Schedule expiry for this key
              setTimeout(() => {
                const m = crossChannelTracker.get(msg.author.id);
                if (m) m.delete(crossKey);
              }, CROSS_CHANNEL_WINDOW_MS);
            }
          }
        }


        // ── Spam detection ──
        const spamCfg = storage.getAutomodConfig();
        const timestamps = spamTracker.get(msg.author.id) ?? [];
        timestamps.push(now);
        // Keep only timestamps within the spam window
        const recent = timestamps.filter((t) => now - t < spamCfg.spamWindowMs);
        spamTracker.set(msg.author.id, recent);

        if (recent.length >= spamCfg.spamThreshold) {
          // Auto-delete the triggering spam message immediately
          await msg.delete().catch(() => {});

          const lastAlert = spamCooldown.get(msg.author.id) ?? 0;
          if (now - lastAlert >= SPAM_ALERT_CD_MS) {
            spamCooldown.set(msg.author.id, now);
            const alertId = `${msg.author.id}_${now}`;
            const snippets = recent.slice(-3).map(() => msg.content.slice(0, 60));
            pendingSpamAlerts.set(alertId, {
              userId: msg.author.id,
              guildId: msg.guild.id,
              channelId: msg.channelId,
              snippets,
            });

            // Log to old staff spam channel (for manual action buttons)
            const spamCh = msg.guild.channels.cache.get(SPAM_LOG_CHANNEL_ID) as TextChannel | null;
            if (spamCh) {
              const member = msg.guild.members.cache.get(msg.author.id);
              const joinedAt = member?.joinedAt;
              const embed = new EmbedBuilder()
                .setColor(0xffa500)
                .setAuthor({ name: "Spam Detected", iconURL: msg.guild.iconURL() ?? undefined })
                .setThumbnail(msg.author.displayAvatarURL())
                .addFields(
                  { name: "User", value: `<@${msg.author.id}> (\`${msg.author.username}\`)`, inline: false },
                  { name: "ID", value: `\`${msg.author.id}\``, inline: true },
                  { name: "Account Created", value: `<t:${Math.floor(msg.author.createdTimestamp / 1000)}:R>`, inline: true },
                  { name: "Joined Server", value: joinedAt ? `<t:${Math.floor(joinedAt.getTime() / 1000)}:R>` : "Unknown", inline: true },
                  { name: "Channel", value: `<#${msg.channelId}>`, inline: true },
                  { name: "Messages in 8s", value: `${recent.length}`, inline: true },
                  { name: "Highlighted Message(s)", value: snippets.map((s) => `> ${s || "(empty)"}`).join("\n").slice(0, 512), inline: false },
                )
                .setTimestamp();

              const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(`spam_action_${alertId}`).setLabel("Take action").setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`spam_ignore_${alertId}`).setLabel("Ignore").setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`spam_info_${alertId}`).setLabel("User info").setStyle(ButtonStyle.Secondary),
              );

              await spamCh.send({ embeds: [embed], components: [row] }).catch(() => {});
            }

            // Also apply progressive punishment for spam
            void applyProgressivePunishment(
              msg.guild,
              msg.author.id,
              "Spamming messages",
              MOD_LOG_CHANNEL_ID,
              "Spam Detected",
              snippets.join(" | ").slice(0, 256),
            );
          }
        }
      })();
    }

    // ── !-prefix message commands ──
    if (msg.content.startsWith("!")) {

      void (async () => {
        const args = msg.content.slice(1).trim().split(/\s+/);
        const cmd  = args[0]?.toLowerCase();
        if (!cmd) return;

        // Route ! commands that mirror slash commands (stats only)
        if (await routeMessageCommand(msg, cmd, args.slice(1))) return;

      })();
      return;
    }

    // ── Sticky repost ──
    const channelStickers = storage.getStickersForChannel(msg.channelId);
    if (channelStickers.length === 0) return;
    if (stickyBusy.has(msg.channelId)) return;
    stickyBusy.add(msg.channelId);
    void (async () => {
      try {
        const ch = msg.channel as TextChannel;
        for (const sticker of channelStickers) {
          // Capture the IDs before any await so they don't change under us
          const oldMsgId = sticker.messageId;
          const stickerText = sticker.text;
          const stickerChannelId = sticker.channelId;
          await ch.messages.fetch(oldMsgId).then((m) => m.delete()).catch(() => {});
          const newMsg = await ch.send({ content: stickerText });
          // repostStickerMessage falls back to channelId+text lookup if the key
          // is stale (e.g. bot restarted mid-repost), so the new ID is always saved.
          storage.repostStickerMessage(stickerChannelId, stickerText, oldMsgId, newMsg.id);
        }
      } finally {
        stickyBusy.delete(msg.channelId);
      }
    })();
  });

  // ── Mod-log deletion guard ───────────────────────────────────────────────────
  // When any message is deleted from the automod log channel, immediately restore
  // it and ping the person who deleted it. Nobody — including owners — can wipe
  // mod-log entries permanently.
  const PROTECTED_LOG_CHANNELS = new Set([MOD_LOG_CHANNEL_ID, SPAM_LOG_CHANNEL_ID]);

  client.on("messageDelete", (msg) => {
    void (async () => {
      if (!PROTECTED_LOG_CHANNELS.has(msg.channelId)) return;
      const guild = msg.guild;
      if (!guild) return;
      // Don't react to the bot's own bulk-delete (e.g. /purge in log channel)
      // but DO react to individual manual deletions.

      // Attempt to identify who deleted the message via audit log
      await new Promise((r) => setTimeout(r, 1000)); // brief delay for audit log propagation
      const auditLogs = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 3 }).catch(() => null);
      const entry = auditLogs?.entries.find(
        (e) =>
          e.target?.id === msg.author?.id &&
          Date.now() - e.createdTimestamp < 5000,
      );
      const deleterId = entry?.executor?.id;

      const logCh = guild.channels.cache.get(msg.channelId) as TextChannel | null;
      if (!logCh) return;

      const alertLine = deleterId
        ? `⚠️ **MODERATOR <@${deleterId}> HAS DELETED A MODLOG ENTRY.** The message has been restored below.`
        : `⚠️ **A MODLOG ENTRY WAS DELETED.** The message has been restored below.`;

      // Rebuild the message — partial messages may not have content/embeds
      if (msg.partial) {
        await logCh.send({ content: alertLine }).catch(() => {});
        return;
      }

      const restoredEmbeds = msg.embeds.length > 0 ? msg.embeds.slice(0, 10) : [];
      const restoredFiles = msg.attachments.map((a) => a.url);

      await logCh.send({
        content: alertLine + (msg.content ? `\n${msg.content}` : ""),
        embeds: restoredEmbeds,
      }).catch(() => {});
    })();
  });

  // ── Reaction roles ──────────────────────────────────────────────────────────
  client.on("inviteCreate", (invite) => {
    const guildId = invite.guild?.id;
    if (!guildId) return;
    const m = _inviteCache.get(guildId) ?? new Map<string, number>();
    m.set(invite.code, invite.uses ?? 0);
    _inviteCache.set(guildId, m);
  });

  client.on("inviteDelete", (invite) => {
    _inviteCache.get(invite.guild?.id ?? "")?.delete(invite.code);
  });

  client.on("messageReactionAdd", async (reaction, user) => {
    if (user.bot) return;
    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }
    if (!reaction.message.guild) return;

    const emojiKey = reaction.emoji.id
      ? `<:${reaction.emoji.name}:${reaction.emoji.id}>`
      : (reaction.emoji.name ?? "");

    const entry = storage.getReactionRole(reaction.message.id, emojiKey);
    if (!entry) return;

    const guild = reaction.message.guild;
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;

    if (!member.roles.cache.has(entry.roleId)) {
      await member.roles.add(entry.roleId).catch(() => {});
    }
  });

  client.on("messageReactionRemove", async (reaction, user) => {
    if (user.bot) return;
    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }
    if (!reaction.message.guild) return;

    const emojiKey = reaction.emoji.id
      ? `<:${reaction.emoji.name}:${reaction.emoji.id}>`
      : (reaction.emoji.name ?? "");

    const entry = storage.getReactionRole(reaction.message.id, emojiKey);
    if (!entry) return;

    const guild = reaction.message.guild;
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;

    if (member.roles.cache.has(entry.roleId)) {
      await member.roles.remove(entry.roleId).catch(() => {});
    }
  });

  client.login(TOKEN).catch((e) => logger.error({ err: e }, "Login failed"));
  return client;
}

async function registerCommands(client: Client) {
  if (!client.user) return;
  const rest = new REST().setToken(TOKEN!);
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Owner control panel"),
    new SlashCommandBuilder()
      .setName("stats")
      .setDescription("Look up a DonutSMP player's statistics")
      .addStringOption((o) =>
        o.setName("username").setDescription("Minecraft username").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("close")
      .setDescription("Close this ticket")
      .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(false)),
    new SlashCommandBuilder()
      .setName("rename")
      .setDescription("Rename this ticket channel")
      .addStringOption((o) => o.setName("name").setDescription("New name").setRequired(true)),
    new SlashCommandBuilder()
      .setName("add")
      .setDescription("Add a user to this ticket")
      .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)),
    new SlashCommandBuilder()
      .setName("remove")
      .setDescription("Remove a user from this ticket")
      .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)),
    new SlashCommandBuilder().setName("tickets").setDescription("List active tickets (staff)"),
    new SlashCommandBuilder()
      .setName("gcreate")
      .setDescription("Create a new giveaway in this channel"),
    new SlashCommandBuilder()
      .setName("greroll")
      .setDescription("Pick a new random winner for an ended giveaway")
      .addStringOption((opt) =>
        opt.setName("id").setDescription("Giveaway ID").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("gend")
      .setDescription("Force-end a running giveaway early")
      .addStringOption((opt) =>
        opt.setName("id").setDescription("Giveaway ID").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("ginfo")
      .setDescription("Look up full details of a giveaway by ID")
      .addStringOption((opt) =>
        opt.setName("id").setDescription("Giveaway ID").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("sticker")
      .setDescription("Manage sticker messages in a channel")
      .addSubcommand((sub) =>
        sub
          .setName("post")
          .setDescription("Post a new sticker message in this channel")
          .addStringOption((opt) =>
            opt.setName("text").setDescription("Sticker content").setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("edit")
          .setDescription("Edit an existing sticker")
          .addStringOption((opt) =>
            opt.setName("id").setDescription("Sticker ID").setRequired(true),
          )
          .addStringOption((opt) =>
            opt.setName("text").setDescription("New content").setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("delete")
          .setDescription("Delete a sticker")
          .addStringOption((opt) =>
            opt.setName("id").setDescription("Sticker ID").setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName("list").setDescription("List all stickers in this channel"),
      ),
    new SlashCommandBuilder()
      .setName("warn")
      .setDescription("Issue a warning to a user (staff only)")
      .addUserOption((opt) => opt.setName("user").setDescription("User to warn").setRequired(true))
      .addStringOption((opt) => opt.setName("reason").setDescription("Reason for the warning").setRequired(true)),
    new SlashCommandBuilder()
      .setName("warns")
      .setDescription("View warnings for a user (staff only)")
      .addUserOption((opt) => opt.setName("user").setDescription("User to check").setRequired(true)),
    new SlashCommandBuilder()
      .setName("removewarn")
      .setDescription("Remove a specific warning from a user (staff only)")
      .addUserOption((opt) => opt.setName("user").setDescription("User to remove a warning from").setRequired(true))
      .addIntegerOption((opt) => opt.setName("warn").setDescription("Warning number to remove (see /warns for the list)").setRequired(true).setMinValue(1)),
    new SlashCommandBuilder()
      .setName("kick")
      .setDescription("Kick a member from the server (staff only)")
      .addUserOption((opt) => opt.setName("user").setDescription("Member to kick").setRequired(true))
      .addStringOption((opt) => opt.setName("reason").setDescription("Reason for kick").setRequired(false)),
    new SlashCommandBuilder()
      .setName("mute")
      .setDescription("Mute (timeout) a member and log a warning")
      .addUserOption((opt) => opt.setName("user").setDescription("Member to mute").setRequired(true))
      .addStringOption((opt) => opt.setName("duration").setDescription("Duration e.g. 10m, 1h, 2d").setRequired(true))
      .addStringOption((opt) => opt.setName("reason").setDescription("Reason for mute").setRequired(false)),
    new SlashCommandBuilder()
      .setName("unmute")
      .setDescription("Remove a member's timeout")
      .addUserOption((opt) => opt.setName("user").setDescription("Member to unmute").setRequired(true))
      .addStringOption((opt) => opt.setName("reason").setDescription("Reason for unmute").setRequired(false)),
    new SlashCommandBuilder()
      .setName("ban")
      .setDescription("Ban a member from the server (staff only)")
      .addUserOption((opt) => opt.setName("user").setDescription("Member to ban").setRequired(true))
      .addStringOption((opt) => opt.setName("reason").setDescription("Reason for ban").setRequired(false)),
    new SlashCommandBuilder()
      .setName("members")
      .setDescription("View server member statistics"),
    new SlashCommandBuilder()
      .setName("buildpayment")
      .setDescription("Send a payment message to the client in this build ticket")
      .addStringOption((o) =>
        o.setName("amount").setDescription("Total price, e.g. 1m, 500k, 1.5b, or 250000").setRequired(false),
      ),
    new SlashCommandBuilder()
      .setName("purge")
      .setDescription("Bulk delete messages from this channel (staff only — helpers max 10, others max 100)")
      .addIntegerOption((o) =>
        o.setName("amount").setDescription("Number of messages to delete (1–100; helpers limited to 10)").setRequired(true).setMinValue(1).setMaxValue(100),
      ),
    new SlashCommandBuilder()
      .setName("requestinvite")
      .setDescription("Request to invite a user into this ticket (ticket channels only)")
      .addUserOption((o) => o.setName("user").setDescription("User to invite").setRequired(true)),
    new SlashCommandBuilder()
      .setName("level")
      .setDescription("View your rank card and XP progress")
      .addUserOption((o) => o.setName("user").setDescription("User to check (defaults to you)").setRequired(false)),
    new SlashCommandBuilder()
      .setName("blacklist")
      .setDescription("Blacklist a user from submitting any applications (owner/co-owner only)")
      .addUserOption((o) => o.setName("user").setDescription("User to blacklist").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Reason for blacklist").setRequired(false)),
    new SlashCommandBuilder()
      .setName("unblacklist")
      .setDescription("Remove a user from the application blacklist (owner/co-owner only)")
      .addUserOption((o) => o.setName("user").setDescription("User to unblacklist").setRequired(true)),
    new SlashCommandBuilder()
      .setName("spawnerpanel")
      .setDescription("Open the spawner admin panel (staff only)"),
    new SlashCommandBuilder()
      .setName("resetlevels")
      .setDescription("Reset ALL player XP and levels to zero (owner only)"),
    new SlashCommandBuilder()
      .setName("modconfig")
      .setDescription("View or edit AutoMod settings (Owner/Co-Owner only)")
      .addSubcommand((sub) => sub.setName("view").setDescription("View current AutoMod configuration"))
      .addSubcommand((sub) =>
        sub
          .setName("addword")
          .setDescription("Add a word to the custom bad-word filter")
          .addStringOption((o) => o.setName("word").setDescription("Word/phrase to block").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("removeword")
          .setDescription("Remove a word from the custom bad-word filter")
          .addStringOption((o) => o.setName("word").setDescription("Word/phrase to remove").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("adddomain")
          .setDescription("Allow links from a domain (in addition to GIF links)")
          .addStringOption((o) => o.setName("domain").setDescription("Domain e.g. youtube.com").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("removedomain")
          .setDescription("Remove a previously allowed domain")
          .addStringOption((o) => o.setName("domain").setDescription("Domain e.g. youtube.com").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("spam")
          .setDescription("Configure spam detection thresholds")
          .addIntegerOption((o) => o.setName("threshold").setDescription("Messages needed to trigger spam alert").setRequired(false).setMinValue(2).setMaxValue(50))
          .addIntegerOption((o) => o.setName("window_seconds").setDescription("Time window in seconds").setRequired(false).setMinValue(1).setMaxValue(120)),
      ),
    new SlashCommandBuilder()
      .setName("modlog")
      .setDescription("View a user's automod violation history (staff only)")
      .addUserOption((o) => o.setName("user").setDescription("User to look up").setRequired(true))
      .addStringOption((o) =>
        o.setName("type").setDescription("Filter by violation type").setRequired(false)
          .addChoices(
            { name: "Prohibited Language", value: "Prohibited Language" },
            { name: "Disallowed Link", value: "Disallowed Link" },
            { name: "Spam Detected", value: "Spam Detected" },
            { name: "Cross-Channel Spam", value: "Cross-Channel Spam" },
            { name: "Bad Word Detected", value: "Bad Word Detected" },
            { name: "Mention Spam", value: "Mention Spam" },
          ),
      )
      .addIntegerOption((o) => o.setName("days").setDescription("Only show violations from the last N days").setRequired(false).setMinValue(1).setMaxValue(365)),
    new SlashCommandBuilder()
      .setName("embed")
      .setDescription("Create and send an embed message")
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription("Creates an embed with the specified color in the specified channel")
          .addStringOption((o) => o.setName("color").setDescription("Hex color code e.g. #ff0000").setRequired(true))
          .addStringOption((o) => o.setName("channel_id").setDescription("Channel to send the embed in (defaults to current channel)").setRequired(false)),
      ),
    new SlashCommandBuilder()
      .setName("reactionrole")
      .setDescription("Manage reaction roles")
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("Attach an emoji reaction to a message that grants a role when clicked")
          .addStringOption((o) => o.setName("message_id").setDescription("ID of the message to react to").setRequired(true))
          .addStringOption((o) => o.setName("emoji").setDescription("Emoji to use (e.g. 🎮 or custom :name:)").setRequired(true))
          .addRoleOption((o) => o.setName("role").setDescription("Role to grant/remove").setRequired(true))
          .addStringOption((o) => o.setName("channel_id").setDescription("Channel the message is in (defaults to current channel)").setRequired(false)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Remove a reaction role from a message")
          .addStringOption((o) => o.setName("message_id").setDescription("Message ID").setRequired(true))
          .addStringOption((o) => o.setName("emoji").setDescription("Emoji to remove").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub.setName("list").setDescription("List all active reaction roles"),
      ),
    new SlashCommandBuilder()
      .setName("stafftasks")
      .setDescription("View your staff performance ledger")
      .addUserOption((o) =>
        o.setName("user").setDescription("View another staff member's tasks (mod+ only)").setRequired(false),
      ),
  ].map((c) => c.toJSON());

  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    for (const guild of client.guilds.cache.values()) {
      await rest
        .put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: cmds })
        .catch(() => {});
    }
    logger.info("Commands registered");
  } catch (e) {
    logger.error({ err: e }, "Command registration failed");
  }
}

async function setupAutoMod(guild: Guild) {
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    logger.warn({ guild: guild.name }, "AutoMod setup skipped: bot is missing the 'Manage Server' permission");
    return;
  }
  const existing = await guild.autoModerationRules.fetch();
  const keywordActions = [
    { type: AutoModerationActionType.BlockMessage, metadata: { customMessage: "🚫 Your message was blocked by AutoMod. Hate speech and slurs are not tolerated." } },
    { type: AutoModerationActionType.SendAlertMessage, metadata: { channel: MOD_LOG_CHANNEL_ID } },
  ] as const;

  const mentionActions = [
    { type: AutoModerationActionType.BlockMessage, metadata: { customMessage: "🚫 Too many mentions in one message." } },
    { type: AutoModerationActionType.SendAlertMessage, metadata: { channel: MOD_LOG_CHANNEL_ID } },
  ] as const;

  const keywordMeta = {
    keywordFilter: [
      "nigger", "niggers", "nigga", "niggas",
      "retard", "retarded", "retards",
      "bastard", "faggot", "faggots", "fag",
      "kike", "kikes", "spic", "spics",
      "chink", "chinks", "wetback", "wetbacks",
    ],
    regexPatterns: [
      "n[i1!|/\\\\]+[g9]+[e3a@4]+[rz]?s?",
      "r[e3@]+t[a4@]+rd(ed|s)?",
      "f[a4@]+[g9]+[o0]?[t7]?s?",
    ],
    presets: [
      AutoModerationRuleKeywordPresetType.Profanity,
      AutoModerationRuleKeywordPresetType.SexualContent,
      AutoModerationRuleKeywordPresetType.Slurs,
    ],
  };

  // ── Keyword filter: delete old bot rule then recreate ──
  const existingKeyword = existing.find((r) => r.name === "Bot – Keyword Filter");
  if (existingKeyword) {
    await existingKeyword.edit({
      triggerMetadata: keywordMeta,
      actions: keywordActions,
      enabled: true,
      reason: "Bot AutoMod refresh",
    }).catch((e) => logger.warn({ err: e, guild: guild.name }, "Failed to update keyword AutoMod rule"));
  } else {
    await guild.autoModerationRules.create({
      name: "Bot – Keyword Filter",
      eventType: 1,
      triggerType: AutoModerationRuleTriggerType.Keyword,
      triggerMetadata: keywordMeta,
      actions: keywordActions,
      enabled: true,
      reason: "Bot AutoMod",
    }).catch((e) => logger.warn({ err: e, guild: guild.name }, "Failed to create keyword AutoMod rule"));
  }

  // ── Mention spam: update if exists, create if not (only 1 allowed per server) ──
  const existingMention = existing.find((r) => r.triggerType === AutoModerationRuleTriggerType.MentionSpam);
  if (existingMention) {
    await existingMention.edit({
      triggerMetadata: { mentionTotalLimit: 4, mentionRaidProtectionEnabled: true },
      actions: mentionActions,
      enabled: true,
      reason: "Bot AutoMod refresh",
    }).catch((e) => logger.warn({ err: e, guild: guild.name }, "Failed to update mention-spam AutoMod rule"));
  } else {
    await guild.autoModerationRules.create({
      name: "Bot – Mention Spam",
      eventType: 1,
      triggerType: AutoModerationRuleTriggerType.MentionSpam,
      triggerMetadata: { mentionTotalLimit: 4, mentionRaidProtectionEnabled: true },
      actions: mentionActions,
      enabled: true,
      reason: "Bot AutoMod",
    }).catch((e) => logger.warn({ err: e, guild: guild.name }, "Failed to create mention-spam AutoMod rule"));
  }
}

async function handleInteraction(i: Interaction) {
  if (i.isChatInputCommand()) return handleCommand(i);
  if (i.isButton()) return handleButton(i);
  if (i.isStringSelectMenu()) return handleStringSelect(i);
  if (i.isChannelSelectMenu()) return handleChannelSelect(i);
  if (i.isModalSubmit()) return handleModal(i);
}

// ── Custom content filters (run on every message, all channels) ──────────────
const BAD_WORD_PATTERNS: RegExp[] = [
  // retard variants
  /\br[e3@]+t[a4@]+rd(ed|s)?\b/i,
  // n-word (hard-r and soft-a) — many leet-speak substitutions
  /\bn[i1!|\/\\]+[g9]+[e3a@4]+[rz]?s?\b/i,
  /\bn[i1!|\/\\]+[g9]{2,}[a@4]+s?\b/i,
  // bastard
  /\bb[a4@]+st[a4@]+rd\b/i,
  // f-slur (faggot/fag)
  /\bf[a4@]+[g9]+[o0]?[t7]?s?\b/i,
  // c-word
  /\bc[u\*]+n+t+s?\b/i,
  // k-slur (kike)
  /\bk[i1]+k[e3]+s?\b/i,
  // sp-slur (spic/spik)
  /\bsp[i1]+[ck]+s?\b/i,
  // cracker (as slur)
  /\bcr[a@4]+ck[e3]+r+s?\b/i,
  // wetback
  /\bw[e3]+t[\s\-_]?b[a4]+ck\b/i,
  // chink
  /\bch[i1]+nk+s?\b/i,
];

function containsBadWord(content: string): boolean {
  if (!content) return false;
  if (BAD_WORD_PATTERNS.some((re) => re.test(content))) return true;
  const customWords = storage.getAutomodConfig().customBadWords;
  if (customWords.length === 0) return false;
  const lower = content.toLowerCase();
  return customWords.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower));
}

const GIF_ALLOWED_DOMAINS = ["tenor.com", "giphy.com", "discord.com", "discordapp.com", "discordapp.net"];
const URL_REGEX = /https?:\/\/[^\s<>]+/gi;

function hasDisallowedLink(content: string): boolean {
  if (!content) return false;
  const urls = content.match(URL_REGEX);
  if (!urls) return false;
  const customDomains = storage.getAutomodConfig().allowedLinkDomains;
  for (const raw of urls) {
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();
      const isAllowedDomain =
        GIF_ALLOWED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`)) ||
        customDomains.some((d) => host === d || host.endsWith(`.${d}`));
      const isGifFile = url.pathname.toLowerCase().endsWith(".gif");
      if (!isAllowedDomain && !isGifFile) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function isOwner(id: string) { return OWNER_IDS.includes(id); }
function isCoOwner(m: GuildMember) { return m.roles.cache.has(CO_OWNER_ROLE_ID) && !isOwner(m.id); }
function isOwnerOrCoOwner(m: GuildMember) {
  return isOwner(m.id) || m.roles.cache.has(OWNER_ROLE_ID) || isCoOwner(m);
}
function isStaff(m: GuildMember) {
  return isOwnerOrCoOwner(m)
    || m.permissions.has(PermissionFlagsBits.ManageChannels)
    || m.permissions.has(PermissionFlagsBits.Administrator)
    || STAFF_ROLE_IDS.some((id) => m.roles.cache.has(id));
}
function isMod(m: GuildMember) {
  return isOwnerOrCoOwner(m) || MOD_ROLE_IDS.some((id) => m.roles.cache.has(id));
}
// Moderator (Mod 3) and above — can view other staff members' tasks
function isModeratorOrAbove(m: GuildMember) {
  return isOwnerOrCoOwner(m) || MOD_ROLE_IDS.slice(2).some((id) => m.roles.cache.has(id));
}
function canUseModLog(m: GuildMember) {
  return isStaff(m) || m.roles.cache.has(MODLOG_STAFF_ROLE_ID);
}
function canManageGiveaway(m: GuildMember) {
  return isOwnerOrCoOwner(m) || m.roles.cache.has(GIVEAWAY_ROLE_ID);
}

async function logToChannel(guild: Guild, channelId: string, embed: EmbedBuilder) {
  const ch = guild.channels.cache.get(channelId) as TextChannel | undefined;
  if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
}

async function closeTicket(
  guild: Guild,
  ticket: NonNullable<ReturnType<typeof storage.getTicket>>,
  channel: TextChannel,
  closedByTag: string,
  closedById: string,
  reason: string,
) {
  const cat = ALL_CATEGORIES.find((c) => c.id === ticket.categoryId);

  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const lines: string[] = [
    `=== Ticket ${ticketTag(ticket.ticketNumber)} | ${cat?.label ?? ticket.categoryId} ===`,
    `Opened: ${ticket.username} | Closed: ${closedByTag} | Reason: ${reason}`,
    `Date: ${new Date().toUTCString()}`,
    `${"─".repeat(40)}`,
  ];
  if (messages) {
    for (const msg of [...messages.values()].reverse()) {
      if (msg.author.bot) continue;
      const time = new Date(msg.createdTimestamp).toISOString().slice(11, 19);
      let line = `[${time}] ${msg.author.username}: ${msg.content.slice(0, 300)}`;
      if (msg.attachments.size > 0) line += ` [+${msg.attachments.size} file(s)]`;
      lines.push(line);
    }
  }
  const transcript = lines.join("\n");

  storage.saveTranscript(ticket.ticketNumber, transcript);

  const transcriptCh = guild.channels.cache.get(TRANSCRIPT_CHANNEL_ID) as TextChannel | undefined;
  const logCh = guild.channels.cache.get(TICKET_LOG_CHANNEL_ID) as TextChannel | undefined;

  const openedTs = Math.floor(new Date(ticket.createdAt).getTime() / 1000);

  const closeEmbed = new EmbedBuilder()
    .setColor(SUCCESS_COLOR)
    .setTitle("Ticket Closed")
    .addFields(
      { name: "Ticket ID",    value: `${ticket.ticketNumber}`,                                        inline: true },
      { name: "Opened By",   value: `<@${ticket.userId}>`,                                           inline: true },
      { name: "Closed By",   value: `<@${closedById}>`,                                              inline: true },
      { name: "Open Time",   value: `<t:${openedTs}:F>`,                                             inline: true },
      { name: "Claimed By",  value: ticket.claimedById ? `<@${ticket.claimedById}>` : "Not claimed", inline: true },
      { name: "Reason",      value: reason },
    )
    
    .setTimestamp();

  const showTranscriptBtn = new ButtonBuilder()
    .setCustomId(`show_transcript_${ticket.ticketNumber}`)
    .setLabel("Show Transcript")
    .setStyle(ButtonStyle.Secondary);

  if (transcriptCh) {
    const transcriptMsg = await transcriptCh
      .send({ embeds: [closeEmbed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(showTranscriptBtn)] })
      .catch(() => null);
    if (transcriptMsg) {
      const editRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`show_transcript_${ticket.ticketNumber}`)
          .setLabel("Show Transcript")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`edit_reason_${guild.id}_${transcriptCh.id}_${transcriptMsg.id}`)
          .setLabel("Edit Reason")
          .setStyle(ButtonStyle.Secondary),
      );
      await transcriptMsg.edit({ components: [editRow] }).catch(() => {});
    }
  }

  if (logCh) {
    await logCh.send({ embeds: [closeEmbed] }).catch(() => {});
  }

  // ── Staff task tracking ───────────────────────────────────────────────────
  // Credit whoever handled (claimed) the ticket; fall back to the closer.
  // Skip if the ticket owner closed their own ticket with no staff involvement.
  const handlerId = ticket.claimedById ?? (closedById !== ticket.userId ? closedById : null);
  if (handlerId) {
    const isBuildTicket = ticket.categoryId === "buy-farms" || ticket.categoryId === "build";
    if (isBuildTicket) {
      storage.incrementBuildsCompleted(handlerId);
    } else if (ticket.categoryId === "giveaway-claim") {
      // For giveaway-claim tickets closed with "paid" → credit the giveaway host
      if (/paid/i.test(reason) && ticket.giveawayId) {
        const gw = storage.getGiveaway(ticket.giveawayId);
        if (gw) {
          const parsed = parsePriceInput(gw.prize);
          if (parsed && parsed > 0) {
            storage.addSponsoredAmount(gw.hostId, parsed);
          }
        }
      }
      storage.incrementStaffHandled(handlerId);
    } else {
      storage.incrementStaffHandled(handlerId);
    }
  }
}

async function handleCommand(i: ChatInputCommandInteraction) {
  // Defer only if the handler takes > 1.5s — fast commands reply instantly
  // with no "thinking..." flash; slow ones still beat Discord's 3s deadline.
  let _deferPromise: Promise<void> | null = null;
  const _deferTimer = setTimeout(() => {
    if (!i.replied && !i.deferred) {
      _deferPromise = i.deferReply({ flags: 64 }).catch(() => {});
    }
  }, 1500);
  const _origReply = i.reply.bind(i);
  (i as any).reply = async (opts: Parameters<typeof i.reply>[0]) => {
    clearTimeout(_deferTimer);
    if (_deferPromise) await _deferPromise;
    if (i.deferred && !i.replied) {
      const payload = (typeof opts === "string" ? { content: opts } : opts) as Record<string, unknown>;
      const { flags: _f, ...rest } = payload;
      return i.editReply(rest as any);
    }
    return _origReply(opts as any);
  };

  const { commandName, user, channel, guild } = i;

  if (commandName === "resetlevels") {
    if (!isOwner(user.id)) {
      await i.reply({ embeds: [errEmbed("Only the server owner can use this command.")], flags: 64 });
      return;
    }
    storage.resetAllXP();
    await i.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(SUCCESS_COLOR)
          .setTitle("✅ Levels Reset")
          .setDescription("All player XP and levels have been wiped. Everyone starts fresh from Level 0."),
      ],
    });
    return;
  }

  if (commandName === "modconfig") {
    if (!guild) return;
    const member = i.member as GuildMember;
    if (!isOwnerOrCoOwner(member)) {
      await i.reply({ embeds: [errEmbed("Only the Owner or Co-Owner can manage AutoMod settings.")], flags: 64 });
      return;
    }
    const sub = i.options.getSubcommand();
    const cfg = storage.getAutomodConfig();

    if (sub === "view") {
      await i.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(BOT_COLOR)
            .setTitle("⚙️ AutoMod Configuration")
            .addFields(
              { name: "Built-in blocked words", value: "retard(ed), n-word (all variants), bastard — always active", inline: false },
              { name: "Custom blocked words", value: cfg.customBadWords.length ? cfg.customBadWords.map((w) => `\`${w}\``).join(", ") : "None", inline: false },
              { name: "Built-in allowed link domains", value: GIF_ALLOWED_DOMAINS.map((d) => `\`${d}\``).join(", "), inline: false },
              { name: "Custom allowed link domains", value: cfg.allowedLinkDomains.length ? cfg.allowedLinkDomains.map((d) => `\`${d}\``).join(", ") : "None", inline: false },
              { name: "Spam threshold", value: `${cfg.spamThreshold} messages`, inline: true },
              { name: "Spam window", value: `${cfg.spamWindowMs / 1000}s`, inline: true },
            ),
        ],
        flags: 64,
      });
      return;
    }

    if (sub === "addword") {
      const word = i.options.getString("word", true);
      const added = storage.addBadWord(word);
      await i.reply({
        embeds: [added
          ? new EmbedBuilder().setColor(SUCCESS_COLOR).setDescription(`✅ Added \`${word.toLowerCase()}\` to the custom bad-word filter.`)
          : errEmbed(`\`${word.toLowerCase()}\` is already in the filter (or invalid).`)],
        flags: 64,
      });
      return;
    }

    if (sub === "removeword") {
      const word = i.options.getString("word", true);
      const removed = storage.removeBadWord(word);
      await i.reply({
        embeds: [removed
          ? new EmbedBuilder().setColor(SUCCESS_COLOR).setDescription(`✅ Removed \`${word.toLowerCase()}\` from the custom bad-word filter.`)
          : errEmbed(`\`${word.toLowerCase()}\` was not found in the custom filter.`)],
        flags: 64,
      });
      return;
    }

    if (sub === "adddomain") {
      const domain = i.options.getString("domain", true);
      const added = storage.addAllowedDomain(domain);
      await i.reply({
        embeds: [added
          ? new EmbedBuilder().setColor(SUCCESS_COLOR).setDescription(`✅ Links from \`${domain.toLowerCase()}\` are now allowed.`)
          : errEmbed(`\`${domain.toLowerCase()}\` is already allowed (or invalid).`)],
        flags: 64,
      });
      return;
    }

    if (sub === "removedomain") {
      const domain = i.options.getString("domain", true);
      const removed = storage.removeAllowedDomain(domain);
      await i.reply({
        embeds: [removed
          ? new EmbedBuilder().setColor(SUCCESS_COLOR).setDescription(`✅ Removed \`${domain.toLowerCase()}\` from the allowed domains.`)
          : errEmbed(`\`${domain.toLowerCase()}\` was not found in the allowed domains.`)],
        flags: 64,
      });
      return;
    }

    if (sub === "spam") {
      const threshold = i.options.getInteger("threshold");
      const windowSeconds = i.options.getInteger("window_seconds");
      if (threshold === null && windowSeconds === null) {
        await i.reply({ embeds: [errEmbed("Provide at least one of `threshold` or `window_seconds`.")], flags: 64 });
        return;
      }
      if (threshold !== null) storage.setSpamThreshold(threshold);
      if (windowSeconds !== null) storage.setSpamWindowMs(windowSeconds * 1000);
      const updated = storage.getAutomodConfig();
      await i.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(SUCCESS_COLOR)
            .setTitle("✅ Spam Settings Updated")
            .addFields(
              { name: "Threshold", value: `${updated.spamThreshold} messages`, inline: true },
              { name: "Window", value: `${updated.spamWindowMs / 1000}s`, inline: true },
            ),
        ],
        flags: 64,
      });
      return;
    }
  }

  if (commandName === "modlog") {
    const modlogMember = i.member as GuildMember | null;
    if (!modlogMember || !canUseModLog(modlogMember)) {
      await i.reply({ embeds: [errEmbed("You don't have permission to use this command.")], flags: 64 });
      return;
    }
    const targetUser = i.options.getUser("user", true);
    const typeFilter = i.options.getString("type");
    const days = i.options.getInteger("days");

    let entries = storage.getViolationLogEntries(targetUser.id);
    if (typeFilter) entries = entries.filter((e) => e.type === typeFilter);
    if (days) {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      entries = entries.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
    }

    if (entries.length === 0) {
      await i.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(BOT_COLOR)
            .setDescription(`No matching violations found for <@${targetUser.id}>.`),
        ],
        flags: 64,
      });
      return;
    }

    const recent = entries.slice(-10).reverse();
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setAuthor({ name: `Violation History: ${targetUser.username}`, iconURL: targetUser.displayAvatarURL() })
      .setDescription(`Showing ${recent.length} of ${entries.length} matching violation(s)${typeFilter ? ` · type: ${typeFilter}` : ""}${days ? ` · last ${days}d` : ""}`)
      .addFields(
        recent.map((e, idx) => ({
          name: `#${entries.length - idx} · ${e.type} · <t:${Math.floor(new Date(e.timestamp).getTime() / 1000)}:R>`,
          value: `**Reason:** ${e.reason}\n**Content:** ${e.snippet ? e.snippet.slice(0, 200) : "(none)"}`,
        })),
      )
      .setFooter({ text: `User ID: ${targetUser.id}` })
      .setTimestamp();

    await i.reply({ embeds: [embed], flags: 64 });
    return;
  }

  if (commandName === "stats") {
    const username = i.options.getString("username", true).trim();
    if (!i.deferred && !i.replied) await i.deferReply();

    type StatsResult = {
      money?: string | number;
      shards?: string | number;
      kills?: string | number;
      deaths?: string | number;
      playtime?: string | number;
      placed_blocks?: string | number;
      broken_blocks?: string | number;
      mobs_killed?: string | number;
      money_spent_on_shop?: string | number;
      money_made_from_sell?: string | number;
    };

    let result: StatsResult;
    let online = false;

    try {
      const [statsRes, lookupRes] = await Promise.all([
        fetch(`https://api.donutsmp.net/v1/stats/${encodeURIComponent(username)}`, {
          headers: { Authorization: `Bearer ${DONUTSMP_API_KEY}` },
        }),
        fetch(`https://api.donutsmp.net/v1/lookup/${encodeURIComponent(username)}`, {
          headers: { Authorization: `Bearer ${DONUTSMP_API_KEY}` },
        }),
      ]);

      if (!statsRes.ok) {
        await i.editReply({ embeds: [errEmbed(`**${username}** doesn't exist on DonutSMP.`)] });
        return;
      }

      const statsJson = (await statsRes.json()) as { status: number; result?: StatsResult };
      if (!statsJson.result) {
        await i.editReply({ embeds: [errEmbed(`**${username}** doesn't exist on DonutSMP.`)] });
        return;
      }
      result = statsJson.result;

      if (lookupRes.ok) {
        const lookupJson = (await lookupRes.json()) as { status?: number };
        online = lookupJson.status === 200;
      }
    } catch {
      await i.editReply({ embeds: [errEmbed("Failed to reach the DonutSMP API. Try again later.")] });
      return;
    }

    const embedColor = online ? ONLINE_COLOR : OFFLINE_COLOR;
    const statusLabel = online ? "Online" : "Offline";

    function parseNum(v: string | number | undefined): number {
      if (v === undefined || v === null) return 0;
      return typeof v === "number" ? v : parseFloat(v);
    }

    const money        = fmtNum(parseNum(result.money));
    const shards       = fmtNum(parseNum(result.shards));
    const kills        = fmtNum(parseNum(result.kills));
    const deaths       = fmtNum(parseNum(result.deaths));
    const playtimeMs   = parseNum(result.playtime);
    const playtime     = fmtPlaytime(Math.floor(playtimeMs / 1000));
    const blocksPlaced = fmtNum(parseNum(result.placed_blocks));
    const blocksBroken = fmtNum(parseNum(result.broken_blocks));
    const mobsKilled   = fmtNum(parseNum(result.mobs_killed));
    const moneyShop    = fmtNum(parseNum(result.money_spent_on_shop));
    const moneySell    = fmtNum(parseNum(result.money_made_from_sell));

    const kdr = parseNum(result.deaths) > 0
      ? (parseNum(result.kills) / parseNum(result.deaths)).toFixed(2)
      : parseNum(result.kills).toFixed(2);

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle(`${username}'s Statistics`)
      .setThumbnail(`https://minotar.net/avatar/${encodeURIComponent(username)}/80`)
      .addFields(
        { name: "Balance",            value: `\`${money}\``,        inline: true },
        { name: "Shards",             value: `\`${shards}\``,       inline: true },
        { name: "Playtime",           value: `\`${playtime}\``,     inline: true },
        { name: "Kills",              value: `\`${kills}\``,        inline: true },
        { name: "Deaths",             value: `\`${deaths}\``,       inline: true },
        { name: "K/D Ratio",          value: `\`${kdr}\``,          inline: true },
        { name: "Blocks Placed",      value: `\`${blocksPlaced}\``, inline: true },
        { name: "Blocks Broken",      value: `\`${blocksBroken}\``, inline: true },
        { name: "Mobs Killed",        value: `\`${mobsKilled}\``,   inline: true },
        { name: "Money Spent (Shop)", value: `\`${moneyShop}\``,    inline: true },
        { name: "Money Made (Sell)",  value: `\`${moneySell}\``,    inline: true },
        { name: "Status",             value: `\`${statusLabel}\``,  inline: true },
      )
      .setFooter({ text: `DonutSMP Stats • ${username}` })
      .setTimestamp();

    await i.editReply({ embeds: [embed] });
    return;
  }

  if (commandName === "warn") {
    if (!isStaff(i.member as GuildMember)) {
      await i.reply({ embeds: [errEmbed("Staff only.")], flags: 64 }); return;
    }
    if (!guild) return;
    const target = i.options.getUser("user", true);
    const reason = i.options.getString("reason", true);
    const warn: WarnEntry = { userId: target.id, reason, moderatorId: user.id, moderatorTag: user.username, timestamp: new Date().toISOString() };
    const count = storage.addWarn(target.id, warn);
    const warnEmbed = new EmbedBuilder()
      .setColor(WARNING_COLOR)
      .setTitle("Warning Issued")
      .addFields(
        { name: "User",            value: `<@${target.id}>`,   inline: true },
        { name: "Moderator",       value: `<@${user.id}>`,     inline: true },
        { name: "Total Warnings",  value: `**${count} / 5**`,  inline: true },
        { name: "Reason",          value: reason },
      )
      .setTimestamp();
    await i.reply({ embeds: [warnEmbed] });
    target.send({ embeds: [warnDmEmbed(reason, count, guild?.name ?? "Bluqo's Bot")] }).catch(() => {});
    if (count >= 5) {
      const m = guild.members.cache.get(target.id);
      if (m?.bannable) await m.ban({ reason: `Auto-ban: 5 warnings reached` }).catch(() => {});
      await (channel as TextChannel).send({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setTitle("Auto-Ban").setDescription(`<@${target.id}> has been automatically banned for accumulating 5 warnings.`).setTimestamp()] }).catch(() => {});
    }
    return;
  }

  if (commandName === "warns") {
    if (!isStaff(i.member as GuildMember)) {
      await i.reply({ embeds: [errEmbed("Staff only.")], flags: 64 }); return;
    }
    const target = i.options.getUser("user", true);
    const warns = storage.getWarns(target.id);
    const color = warns.length >= 5 ? ERROR_COLOR : warns.length >= 3 ? WARNING_COLOR : BOT_COLOR;
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`Warnings: ${target.username}`)
      .setDescription(
        warns.length === 0
          ? "No warnings on record."
          : warns.map((w, idx) => `**${idx + 1}.** ${w.reason}\n> by <@${w.moderatorId}> · <t:${Math.floor(new Date(w.timestamp).getTime() / 1000)}:R>`).join("\n\n"),
      )
      .setFooter({ text: `${warns.length} / 5 warnings` })
      .setTimestamp();
    await i.reply({ embeds: [embed], flags: 64 });
    return;
  }

  if (commandName === "removewarn") {
    if (!isStaff(i.member as GuildMember)) {
      await i.reply({ embeds: [errEmbed("Staff only.")], flags: 64 }); return;
    }
    const target = i.options.getUser("user", true);
    const warnNum = i.options.getInteger("warn", true);
    const warns = storage.getWarns(target.id);
    if (warns.length === 0) {
      await i.reply({ embeds: [errEmbed(`${target.username} has no warnings.`)], flags: 64 }); return;
    }
    if (warnNum > warns.length) {
      await i.reply({ embeds: [errEmbed(`Invalid warning number. ${target.username} only has ${warns.length} warning${warns.length !== 1 ? "s" : ""}.`)], flags: 64 }); return;
    }
    const removed = warns[warnNum - 1]!;
    storage.removeWarn(target.id, warnNum - 1);
    const remaining = storage.getWarns(target.id).length;
    await i.reply({
      embeds: [new EmbedBuilder()
        .setColor(SUCCESS_COLOR)
        .setTitle("Warning Removed")
        .addFields(
          { name: "User",      value: `<@${target.id}>`,   inline: true },
          { name: "Removed #", value: `${warnNum}`,        inline: true },
          { name: "Remaining", value: `${remaining} / 5`,  inline: true },
          { name: "Reason",    value: removed.reason },
        )
        .setTimestamp()],
    });
    return;
  }

  if (commandName === "kick") {
    if (!isStaff(i.member as GuildMember)) {
      await i.reply({ embeds: [errEmbed("Staff only.")], flags: 64 }); return;
    }
    if (!guild) return;
    const target = i.options.getUser("user", true);
    const reason = i.options.getString("reason") || "No reason provided";
    const m = guild.members.cache.get(target.id);
    if (!m) { await i.reply({ embeds: [errEmbed("Member not found in this server.")], flags: 64 }); return; }
    if (!m.kickable) { await i.reply({ embeds: [errEmbed("I cannot kick this member.")], flags: 64 }); return; }
    if (!i.deferred && !i.replied) await i.deferReply();
    await m.kick(reason);
    await i.editReply({ embeds: [new EmbedBuilder().setColor(WARNING_COLOR).setTitle("Member Kicked").addFields({ name: "User", value: `<@${target.id}>`, inline: true }, { name: "Moderator", value: `<@${user.id}>`, inline: true }, { name: "Reason", value: reason }).setTimestamp()] });
    return;
  }

  if (commandName === "ban") {
    if (!isStaff(i.member as GuildMember)) {
      await i.reply({ embeds: [errEmbed("Staff only.")], flags: 64 }); return;
    }
    if (!guild) return;
    const target = i.options.getUser("user", true);
    const reason = i.options.getString("reason") || "No reason provided";
    const m = guild.members.cache.get(target.id);
    if (m && !m.bannable) { await i.reply({ embeds: [errEmbed("I cannot ban this member.")], flags: 64 }); return; }
    if (!i.deferred && !i.replied) await i.deferReply();
    await guild.members.ban(target.id, { reason });
    await i.editReply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setTitle("Member Banned").addFields({ name: "User", value: `<@${target.id}>`, inline: true }, { name: "Moderator", value: `<@${user.id}>`, inline: true }, { name: "Reason", value: reason }).setTimestamp()] });
    return;
  }

  if (commandName === "mute") {
    if (!isStaff(i.member as GuildMember)) {
      await i.reply({ embeds: [errEmbed("Staff only.")], flags: 64 }); return;
    }
    if (!guild) return;
    const target = i.options.getUser("user", true);
    const durationInput = i.options.getString("duration", true);
    const reason = i.options.getString("reason") || "No reason provided";
    const durationMs = parseDuration(durationInput);
    if (!durationMs) {
      await i.reply({ embeds: [errEmbed("Invalid duration. Use e.g. `10m`, `1h`, `2d`.")], flags: 64 }); return;
    }
    const m = guild.members.cache.get(target.id);
    if (!m) { await i.reply({ embeds: [errEmbed("Member not found in this server.")], flags: 64 }); return; }
    if (!m.moderatable) { await i.reply({ embeds: [errEmbed("I cannot mute this member.")], flags: 64 }); return; }
    if (!i.deferred && !i.replied) await i.deferReply();
    await m.timeout(durationMs, reason);
    // Log a warn
    const warnEntry: WarnEntry = { userId: target.id, reason: `Mute: ${reason}`, moderatorId: user.id, moderatorTag: user.username, timestamp: new Date().toISOString() };
    const warnCount = storage.addWarn(target.id, warnEntry);
    // DM the target — include warn count so they know they've been warned
    target.send({ embeds: [muteDmEmbed(reason, durationInput, `@${user.username}`, guild.name, warnCount)] }).catch(() => {});
    await i.editReply({
      embeds: [new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle("Member Muted")
        .addFields(
          { name: "User",      value: `<@${target.id}>`,      inline: true },
          { name: "Moderator", value: `<@${user.id}>`,         inline: true },
          { name: "Duration",  value: durationInput,            inline: true },
          { name: "Reason",    value: reason },
          { name: "Warn",      value: `${warnCount} / 5` },
        )
        .setTimestamp()],
    });
    if (warnCount >= 5 && m.bannable) {
      await m.ban({ reason: "Auto-ban: 5 warnings" }).catch(() => {});
    }
    return;
  }

  if (commandName === "unmute") {
    if (!isStaff(i.member as GuildMember)) {
      await i.reply({ embeds: [errEmbed("Staff only.")], flags: 64 }); return;
    }
    if (!guild) return;
    const target = i.options.getUser("user", true);
    const reason = i.options.getString("reason") || "Manually removed";
    const m = guild.members.cache.get(target.id);
    if (!m) { await i.reply({ embeds: [errEmbed("Member not found in this server.")], flags: 64 }); return; }
    if (!m.communicationDisabledUntil) {
      await i.reply({ embeds: [errEmbed("This member is not currently muted.")], flags: 64 }); return;
    }
    if (!i.deferred && !i.replied) await i.deferReply();
    await m.timeout(null, reason);
    // DM the target
    target.send({ embeds: [unmuteDmEmbed(reason, `@${user.username}`, guild.name)] }).catch(() => {});
    await i.editReply({
      embeds: [new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("Member Unmuted")
        .addFields(
          { name: "User",      value: `<@${target.id}>`, inline: true },
          { name: "Moderator", value: `<@${user.id}>`,   inline: true },
          { name: "Reason",    value: reason },
        )
        .setTimestamp()],
    });
    return;
  }

  if (commandName === "members") {
    if (!guild) return;
    if (!i.deferred && !i.replied) await i.deferReply();
    const g = await guild.fetch();
    await g.members.fetch().catch(() => {});
    const online = g.members.cache.filter((m) => m.presence?.status !== "offline" && !!m.presence?.status).size;
    const bots   = g.members.cache.filter((m) => m.user.bot).size;
    const humans = g.memberCount - bots;
    const embed = new EmbedBuilder()
      .setColor(BOT_COLOR)
      .setTitle(`Members: ${g.name}`)
      .setThumbnail(g.iconURL())
      .addFields(
        { name: "Total",  value: `${g.memberCount}`, inline: true },
        { name: "Humans", value: `${humans}`,         inline: true },
        { name: "Bots",   value: `${bots}`,           inline: true },
        { name: "Online", value: `${online || "N/A"}`, inline: true },
      )
      .setTimestamp();
    await i.editReply({ embeds: [embed] });
    return;
  }

  if (commandName === "panel") {
    if (!isOwnerOrCoOwner(i.member as GuildMember)) {
      await i.reply({ embeds: [errEmbed("You are not authorized.")], flags: 64 });
      return;
    }
    await i.reply({ embeds: [panelEmbed()], components: panelRows(), flags: 64 });
    return;
  }

  if (commandName === "gcreate") {
    const member = i.member as GuildMember;
    if (!canManageGiveaway(member)) {
      await i.reply({ embeds: [errEmbed("You need the Giveaway Manager role to create giveaways.")], flags: 64 });
      return;
    }
    const modal = new ModalBuilder().setCustomId("mod_giveaway_create").setTitle("Create Giveaway");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("prize")
          .setLabel("Prize")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 20m")
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("duration")
          .setLabel("Duration")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 30s, 5m, 1h, 1d, 2h30m")
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("winners")
          .setLabel("Number of Winners")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 1")
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("type")
          .setLabel("Type")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("normal  |  simple (no claim)  |  double (take or pass doubled)  |  quickdrop (fast, 30s-1h)")
          .setRequired(false),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("description")
          .setLabel("Description (optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false),
      ),
    );
    await i.showModal(modal);
    return;
  }

  if (commandName === "ginfo") {
    const member = i.member as GuildMember;
    if (!canManageGiveaway(member)) {
      await i.reply({ embeds: [errEmbed("You need the Giveaway Manager role to look up giveaways.")], flags: 64 });
      return;
    }
    const gwId = i.options.getString("id", true).trim();
    const gw = storage.getGiveaway(gwId);
    if (!gw) {
      await i.reply({ embeds: [errEmbed(`No giveaway found with ID \`${gwId}\`.`)], flags: 64 });
      return;
    }

    const endTs = Math.floor(new Date(gw.endTime).getTime() / 1000);
    const status = gw.ended ? "Ended" : "Active";
    const statusColor = gw.ended ? 0x747f8d : 0xf47bff;
    const typeLabel = gw.type === "simple" ? "Simple (no claim)" : gw.type === "double" ? "Double (take or pass doubled)" : gw.type === "quickdrop" ? "Quickdrop (10 min claim)" : "Normal";
    const winnersStr = gw.winners.length > 0 ? gw.winners.map((id) => `<@${id}>`).join(", ") : "None yet";
    const claimedStr = gw.claimedBy.length > 0 ? gw.claimedBy.map((id) => `<@${id}>`).join(", ") : "None";
    const entriesStr = gw.entries.length > 0
      ? gw.entries.slice(0, 30).map((id) => `<@${id}>`).join(", ") + (gw.entries.length > 30 ? ` + ${gw.entries.length - 30} more` : "")
      : "No entries";

    const embed = new EmbedBuilder()
      .setColor(statusColor)
      .setTitle(`${gw.prize}`)
      .addFields(
        { name: "Status",    value: status,                              inline: true },
        { name: "Type",      value: typeLabel,                           inline: true },
        { name: "Winners",   value: `${gw.winnersCount}`,               inline: true },
        { name: "Hosted by", value: `<@${gw.hostId}>`,                  inline: true },
        { name: "Ends",      value: `<t:${endTs}:f> (<t:${endTs}:R>)`, inline: true },
        { name: "Channel",   value: `<#${gw.channelId}>`,               inline: true },
        { name: `Entries (${gw.entries.length})`, value: entriesStr },
        { name: `Winners (${gw.winners.length})`, value: winnersStr,    inline: true },
        { name: `Claimed (${gw.claimedBy.length})`, value: claimedStr,  inline: true },
        ...(gw.description ? [{ name: "Description", value: gw.description }] : []),
      )
      .setFooter({ text: `Giveaway ID: ${gw.id}` })
      .setTimestamp();

    await i.reply({ embeds: [embed], flags: 64 });
    return;
  }

  if (commandName === "greroll") {
    const member = i.member as GuildMember;
    if (!canManageGiveaway(member)) {
      await i.reply({ embeds: [errEmbed("You need the Giveaway Manager role to reroll giveaways.")], flags: 64 });
      return;
    }
    const gwId = i.options.getString("id", true).trim();
    const gw = storage.getGiveaway(gwId);
    if (!gw) {
      await i.reply({ embeds: [errEmbed(`No giveaway found with ID \`${gwId}\`.`)], flags: 64 });
      return;
    }
    if (!gw.ended) {
      await i.reply({ embeds: [errEmbed("That giveaway is still running.")], flags: 64 });
      return;
    }
    if (gw.entries.length === 0) {
      await i.reply({ embeds: [errEmbed("No entries to reroll from.")], flags: 64 });
      return;
    }
    if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });
    const pool = gw.entries.filter((id) => !gw.claimedBy.includes(id));
    const eligible = pool.length > 0 ? pool : gw.entries;
    const newWinner = eligible[Math.floor(Math.random() * eligible.length)];
    const ch = i.channel as TextChannel;
    await ch.send({ content: `Reroll! Congratulations <@${newWinner}>, you won **${gw.prize}**!` });
    await i.editReply({ embeds: [new EmbedBuilder().setColor(BOT_COLOR).setDescription(`New winner: <@${newWinner}>`)] });
    return;
  }

  if (commandName === "gend") {
    const member = i.member as GuildMember;
    if (!canManageGiveaway(member)) {
      await i.reply({ embeds: [errEmbed("You need the Giveaway Manager role to end giveaways.")], flags: 64 });
      return;
    }
    const gwId = i.options.getString("id", true).trim();
    const gw = storage.getGiveaway(gwId);
    if (!gw) {
      await i.reply({ embeds: [errEmbed(`No giveaway found with ID \`${gwId}\`.`)], flags: 64 });
      return;
    }
    if (gw.ended) {
      await i.reply({ embeds: [errEmbed("That giveaway has already ended.")], flags: 64 });
      return;
    }
    const timer = activeGiveawayTimers.get(gwId);
    if (timer) { clearTimeout(timer); activeGiveawayTimers.delete(gwId); }
    if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });
    await endGiveaway(gw);
    await i.editReply({ embeds: [okEmbed("Giveaway ended.")] });
    return;
  }

  if (commandName === "tickets") {
    if (!guild) return;
    const member = i.member as GuildMember;
    if (!isStaff(member)) { await i.reply({ embeds: [errEmbed("Staff only.")], flags: 64 }); return; }
    const list = storage.getTicketsByGuild(guild.id);
    const embed = new EmbedBuilder()
      .setColor(BOT_COLOR)
      .setTitle(`Active Tickets: ${list.length} open`)
      .setDescription(
        list.length === 0
          ? "No open tickets."
          : list.slice(0, 25).map((t) => {
              const cat = ALL_CATEGORIES.find((c) => c.id === t.categoryId);
              return `**${ticketTag(t.ticketNumber)}** <#${t.channelId}> - ${cat?.label ?? t.categoryId} - <@${t.userId}>`;
            }).join("\n"),
      )
      
      .setTimestamp();
    await i.reply({ embeds: [embed], flags: 64 });
    return;
  }

  if (commandName === "stafftasks") {
    if (!guild) return;
    const member = i.member as GuildMember;
    if (!isStaff(member)) {
      await i.reply({ embeds: [errEmbed("Staff only.")], flags: 64 });
      return;
    }

    const targetUser = i.options.getUser("user", false);

    // Viewing another user requires Moderator (Mod 3) or above
    if (targetUser && targetUser.id !== user.id && !isModeratorOrAbove(member)) {
      await i.reply({ embeds: [errEmbed("You need to be a Moderator or above to view another member's tasks.")], flags: 64 });
      return;
    }

    const viewSelf = !targetUser || targetUser.id === user.id;
    const subjectId = viewSelf ? user.id : targetUser!.id;
    const subjectUser = viewSelf ? user : targetUser!;

    // Fetch the subject's guild member so we can check their roles for label customisation
    const subjectMember = guild.members.cache.get(subjectId)
      ?? await guild.members.fetch(subjectId).catch(() => null);

    const tasks = storage.getStaffTask(subjectId);

    const isBuilder  = subjectMember?.roles.cache.has(BUILD_TICKET_ROLE_ID) ?? false;
    const isGiveawayMgr = subjectMember?.roles.cache.has(GIVEAWAY_ROLE_ID) ?? false;
    const viewerIsMod = isModeratorOrAbove(member); // Mod 3+ see all fields and can view others

    // ── Build embed ──────────────────────────────────────────────────────────
    const embed = new EmbedBuilder()
      .setColor(BOT_COLOR)
      .setTitle("Taskbook Tasks")
      .setDescription(
        viewSelf
          ? "Staff performance ledger · auto-tracked on ticket actions"
          : `Staff performance ledger for <@${subjectId}> · auto-tracked on ticket actions`,
      )
      .setThumbnail(subjectUser.displayAvatarURL())
      .setFooter({ text: viewSelf ? `Your stats, ${user.username}` : `Viewing ${subjectUser.username}'s stats` })
      .setTimestamp();

    // Tickets Renamed — all staff
    embed.addFields({ name: "Tickets Renamed", value: `${tasks.ticketsRenamed}`, inline: true });

    // Tickets Handled / Builds Complete — label depends on role
    if (!viewerIsMod && isBuilder) {
      // Builder viewing own stats: show builds
      embed.addFields({ name: "Builds Complete", value: `${tasks.buildsCompleted}`, inline: true });
    } else if (!viewerIsMod && !isBuilder) {
      // Non-builder staff viewing own stats: show handled
      embed.addFields({ name: "Tickets Handled", value: `${tasks.ticketsHandled}`, inline: true });
    } else {
      // Mod+ viewing someone else (or own): show both
      embed.addFields(
        { name: "Tickets Handled", value: `${tasks.ticketsHandled}`, inline: true },
        { name: "Builds Complete", value: `${tasks.buildsCompleted}`, inline: true },
      );
    }

    // Sponsored Amount — always shown if giveaway manager, or if mod+ is viewing
    if (isGiveawayMgr || viewerIsMod) {
      const sponsoredDisplay = tasks.sponsoredAmount >= 1_000_000_000
        ? `${(tasks.sponsoredAmount / 1_000_000_000).toFixed(2)}b`
        : tasks.sponsoredAmount >= 1_000_000
        ? `${(tasks.sponsoredAmount / 1_000_000).toFixed(2)}m`
        : tasks.sponsoredAmount >= 1_000
        ? `${(tasks.sponsoredAmount / 1_000).toFixed(1)}k`
        : `${tasks.sponsoredAmount}`;
      embed.addFields({ name: "Sponsored Amount", value: sponsoredDisplay, inline: true });
    }

    // Messages — always shown
    embed.addFields({ name: "Messages Sent", value: `${tasks.messagesSent}`, inline: true });

    await i.reply({ embeds: [embed], flags: 64 });
    return;
  }

  if (commandName === "purge") {
    const member = i.member as GuildMember;
    if (!isStaff(member)) {
      await i.reply({ embeds: [errEmbed("Staff only.")], flags: 64 }); return;
    }
    if (!channel || !guild) return;
    const amount = i.options.getInteger("amount", true);

    // Tiered purge limit: Mod 1 (Helper) can only delete up to 10 messages
    const isHelper = MOD_ROLE_IDS[0] !== undefined && member.roles.cache.has(MOD_ROLE_IDS[0]) && !isMod(member) && !isOwnerOrCoOwner(member);
    const maxAllowed = isHelper ? 10 : 100;
    if (amount > maxAllowed) {
      await i.reply({
        embeds: [errEmbed(`You can only purge up to **${maxAllowed}** messages${isHelper ? " (Helper limit)" : ""}.`)],
        flags: 64,
      });
      return;
    }

    if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });
    const fetched = await (channel as TextChannel).messages.fetch({ limit: amount });
    const deleted = await (channel as TextChannel).bulkDelete(fetched, true).catch(() => null);
    const count = deleted?.size ?? 0;
    const confirm = await (channel as TextChannel).send({
      embeds: [new EmbedBuilder().setColor(SUCCESS_COLOR)
        .setDescription(`🗑️ ${count} message${count !== 1 ? "s were" : " was"} removed.`)
        .setFooter({ text: `Purged by ${user.username}` })],
    });
    setTimeout(() => confirm.delete().catch(() => {}), 5000);
    await i.editReply({ content: `✅ Deleted ${count} messages.` });
    return;
  }

  if (commandName === "requestinvite") {
    if (!guild || !channel) return;
    const ticket = storage.getTicket(channel.id);
    if (!ticket) {
      await i.reply({ embeds: [errEmbed("Ticket only — this command can only be used inside a ticket channel.")], flags: 64 });
      return;
    }
    const target = i.options.getUser("user", true);
    if (target.id === user.id) {
      await i.reply({ embeds: [errEmbed("You can't invite yourself.")], flags: 64 });
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(BOT_COLOR)
      .setTitle("📨 Invite Request")
      .setDescription(`<@${user.id}> is requesting to add <@${target.id}> to this ticket.`)
      .addFields(
        { name: "Requested by", value: `<@${user.id}>`, inline: true },
        { name: "Invite",       value: `<@${target.id}>`, inline: true },
      )
      .setTimestamp();
    const acceptBtn = new ButtonBuilder()
      .setCustomId(`requestinvite_accept_${target.id}`)
      .setLabel("Accept - Add to ticket")
      .setStyle(ButtonStyle.Success);
    const denyBtn = new ButtonBuilder()
      .setCustomId(`requestinvite_deny_${target.id}`)
      .setLabel("❌ Deny")
      .setStyle(ButtonStyle.Danger);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(acceptBtn, denyBtn);
    await i.reply({ embeds: [embed], components: [row] });
    return;
  }

  if (commandName === "level") {
    const target = i.options.getUser("user", false) ?? user;
    const member = guild?.members.cache.get(target.id) ?? await guild?.members.fetch(target.id).catch(() => null);

    const entry = storage.getXP(target.id);
    const totalXp = entry.xp;
    const { level, currentXp, neededXp } = computeLevel(totalXp);

    // Compute rank among all tracked users in this guild
    const allXp = Object.entries(storage.getAllXP());
    const sorted = allXp.sort((a, b) => b[1].xp - a[1].xp);
    const rankPos = sorted.findIndex(([id]) => id === target.id) + 1;
    const rank = rankPos > 0 ? rankPos : allXp.length + 1;

    // Build XP progress bar (20 segments)
    const BAR_LENGTH = 20;
    const filled = Math.round((currentXp / neededXp) * BAR_LENGTH);
    const bar = "█".repeat(filled) + "░".repeat(BAR_LENGTH - filled);

    const pct = Math.round((currentXp / neededXp) * 100);
    const displayName = member?.displayName ?? target.username;
    const avatarUrl = target.displayAvatarURL({ size: 256 });

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: displayName, iconURL: avatarUrl })
      .setThumbnail(avatarUrl)
      .addFields(
        { name: "RANK", value: `**#${rank}**`, inline: true },
        { name: "LEVEL", value: `**${level}**`, inline: true },
        { name: "TOTAL XP", value: `**${totalXp.toLocaleString()} XP**`, inline: true },
        {
          name: `XP Progress (${pct}%)`,
          value: `\`${bar}\`\n**${currentXp.toLocaleString()}** / **${neededXp.toLocaleString()} XP** to level **${level + 1}**`,
          inline: false,
        },
      )
      .setFooter({ text: "Bluqo's Bot Rank Card", iconURL: guild?.iconURL() ?? undefined })
      .setTimestamp();

    await i.reply({ embeds: [embed] });
    return;
  }

  if (commandName === "buildpayment") {
    if (!channel || !guild) return;
    const channelId = channel.id;
    const ticket = storage.getTicket(channelId);
    const amountStr = i.options.getString("amount", false);
    const manualAmount = amountStr ? parsePriceInput(amountStr) : null;

    if (amountStr && manualAmount === null) {
      await i.reply({ embeds: [errEmbed(`Couldn't parse \`${amountStr}\`. Use formats like \`1m\`, \`500k\`, \`1.5b\`, or \`250000\`.`)], flags: 64 });
      return;
    }

    if (manualAmount !== null && manualAmount > 0) {
      if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });
      const price = manualAmount;
      const priceStr = formatPriceDisplay(price, amountStr!);
      const memberId = ticket?.userId ?? null;
      await (channel as TextChannel).send({
        content: memberId ? `<@${memberId}>` : undefined,
        embeds: [buildPaymentEmbed(price, priceStr)],
      });
      await i.editReply({ content: "✅ Payment message sent." });
      return;
    }

    await i.reply({
      embeds: [errEmbed("Please provide an `amount` to send a payment message.")],
      flags: 64,
    });
    return;
  }

  if (commandName === "close") {
    if (!channel || !guild) return;
    const ticket = storage.getTicket(channel.id);
    if (!ticket) { await i.reply({ embeds: [errEmbed("Not a ticket channel.")], flags: 64 }); return; }
    const member = i.member as GuildMember;
    if (!isStaff(member) && ticket.userId !== user.id) {
      await i.reply({ embeds: [errEmbed("No permission to close this ticket.")], flags: 64 }); return;
    }
    const reason = i.options.getString("reason") ?? "No reason specified";
    await i.reply({ embeds: [infoEmbed("Closing ticket in 5 seconds. A transcript will be saved.")] });
    await closeTicket(guild, ticket, channel as TextChannel, user.username, user.id, reason);
    setTimeout(async () => {
      storage.removeTicket(channel.id);
      await (channel as TextChannel).delete("Ticket closed").catch(() => {});
    }, 5000);
    return;
  }

  if (commandName === "rename") {
    if (!channel || !guild) return;
    const ticket = storage.getTicket(channel.id);
    if (!ticket) { await i.reply({ embeds: [errEmbed("Not a ticket channel.")], flags: 64 }); return; }
    if (!isStaff(i.member as GuildMember)) { await i.reply({ embeds: [errEmbed("Staff only.")], flags: 64 }); return; }
    const newName = i.options.getString("name", true).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 90);
    await (channel as TextChannel).setName(newName);
    storage.incrementStaffRename(user.id);
    await i.reply({ embeds: [okEmbed(`Channel renamed to **${newName}**`)] });
    await (channel as TextChannel).send({ content: `<@${user.id}> has renamed the ticket to **${newName}**` });
    return;
  }

  if (commandName === "add") {
    if (!channel || !guild) return;
    if (!storage.getTicket(channel.id)) { await i.reply({ embeds: [errEmbed("Not a ticket channel.")], flags: 64 }); return; }
    const target = i.options.getUser("user", true);
    await (channel as TextChannel).permissionOverwrites.edit(target.id, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
    });
    await i.reply({ embeds: [okEmbed(`Added <@${target.id}> to this ticket.`)] });
    return;
  }

  if (commandName === "remove") {
    if (!channel || !guild) return;
    if (!storage.getTicket(channel.id)) { await i.reply({ embeds: [errEmbed("Not a ticket channel.")], flags: 64 }); return; }
    const target = i.options.getUser("user", true);
    await (channel as TextChannel).permissionOverwrites.delete(target.id);
    await i.reply({ embeds: [okEmbed(`Removed <@${target.id}> from this ticket.`)] });
    return;
  }

  if (commandName === "sticker") {
    if (!guild || !channel) return;
    const member = i.member as GuildMember;
    if (!isOwnerOrCoOwner(member)) {
      await i.reply({ embeds: [errEmbed("Only the Owner or Co-Owner can manage stickers.")], flags: 64 });
      return;
    }
    const sub = i.options.getSubcommand();

    if (sub === "post") {
      const text = i.options.getString("text", true);
      if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });
      const msg = await (channel as TextChannel).send({ content: text });
      storage.addSticker({
        channelId: channel.id,
        guildId: guild.id,
        messageId: msg.id,
        text,
        createdAt: new Date().toISOString(),
      });
      await i.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(SUCCESS_COLOR)
            .setDescription(`📌 Sticker posted.\n**Message ID:** \`${msg.id}\``),
        ],
      });
      return;
    }

    if (sub === "edit") {
      const msgId = i.options.getString("id", true).trim();
      const newText = i.options.getString("text", true);
      const sticker = storage.getSticker(msgId);
      if (!sticker) {
        await i.reply({ embeds: [errEmbed(`No sticker found with message ID \`${msgId}\`.`)], flags: 64 });
        return;
      }
      if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });
      const stickerCh = guild.channels.cache.get(sticker.channelId) as TextChannel | undefined;
      if (stickerCh) {
        await stickerCh.messages.fetch(sticker.messageId).then((m) => m.delete()).catch(() => {});
        const newMsg = await stickerCh.send({ content: newText });
        storage.updateStickerText(newMsg.id, newText);
        storage.replaceStickerMessage(msgId, newMsg.id);
        await i.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(SUCCESS_COLOR)
              .setDescription(`📌 Sticker updated.\n**New Message ID:** \`${newMsg.id}\``),
          ],
        });
      } else {
        storage.updateStickerText(msgId, newText);
        await i.editReply({ embeds: [okEmbed("Sticker text updated.")] });
      }
      return;
    }

    if (sub === "delete") {
      const msgId = i.options.getString("id", true).trim();
      const sticker = storage.deleteSticker(msgId);
      if (!sticker) {
        await i.reply({ embeds: [errEmbed(`No sticker found with message ID \`${msgId}\`.`)], flags: 64 });
        return;
      }
      if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });
      try {
        const stickerCh = guild.channels.cache.get(sticker.channelId) as TextChannel | undefined;
        if (stickerCh) {
          await stickerCh.messages.fetch(sticker.messageId).then((m) => m.delete()).catch(() => {});
        }
      } catch {}
      await i.editReply({ embeds: [okEmbed(`Sticker deleted.`)] });
      return;
    }

    if (sub === "list") {
      const stickers = storage.getStickersForChannel(channel.id);
      if (stickers.length === 0) {
        await i.reply({ embeds: [infoEmbed("No stickers in this channel.")], flags: 64 });
        return;
      }
      const lines = stickers.map(
        (s) => `\`${s.messageId}\` — ${s.text.slice(0, 80)}${s.text.length > 80 ? "…" : ""}`,
      );
      await i.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(BOT_COLOR)
            .setTitle(`Stickers in this channel (${stickers.length})`)
            .setDescription(lines.join("\n")),
        ],
        flags: 64,
      });
      return;
    }
  }

  if (commandName === "blacklist") {
    if (!guild) return;
    const member = i.member as GuildMember;
    if (!isOwnerOrCoOwner(member)) {
      await i.reply({ embeds: [errEmbed("Only the Owner or Co-Owner can blacklist users.")], flags: 64 });
      return;
    }
    const target = i.options.getUser("user", true);
    const reason = i.options.getString("reason") ?? "No reason provided";
    storage.addAppBlacklist(target.id, reason, user.tag);
    await i.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(ERROR_COLOR)
          .setTitle("🚫 Application Blacklist")
          .setDescription(`<@${target.id}> has been blacklisted from submitting applications.`)
          .addFields({ name: "Reason", value: reason })
          .setTimestamp(),
      ],
    });
    return;
  }

  if (commandName === "unblacklist") {
    if (!guild) return;
    const member = i.member as GuildMember;
    if (!isOwnerOrCoOwner(member)) {
      await i.reply({ embeds: [errEmbed("Only the Owner or Co-Owner can unblacklist users.")], flags: 64 });
      return;
    }
    const target = i.options.getUser("user", true);
    const removed = storage.removeAppBlacklist(target.id);
    if (!removed) {
      await i.reply({ embeds: [errEmbed(`<@${target.id}> is not on the application blacklist.`)], flags: 64 });
      return;
    }
    await i.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(SUCCESS_COLOR)
          .setTitle("✅ Application Blacklist Removed")
          .setDescription(`<@${target.id}> has been removed from the application blacklist and may now submit applications.`)
          .setTimestamp(),
      ],
    });
    return;
  }

  if (commandName === "spawnerpanel") {
    if (!guild) return;
    const member = i.member as GuildMember;
    if (!isStaff(member)) {
      await i.reply({ embeds: [errEmbed("Only staff can access the spawner panel.")], flags: 64 });
      return;
    }
    const spEmbed = new EmbedBuilder()
      .setColor(SKELLY_CATEGORY.color)
      .setTitle("Spawner Admin Panel")
      .setDescription("Manage spawner stock and prices.")
      .setTimestamp();
    const spRow1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("sp_list").setLabel("List").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("sp_add_stock").setLabel("Add Stock").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("sp_rem_stock").setLabel("Remove Stock").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("sp_set_price").setLabel("Set Price").setStyle(ButtonStyle.Secondary),
    );
    const spRow2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("sp_add_type").setLabel("Add Type").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("sp_del_type").setLabel("Delete Type").setStyle(ButtonStyle.Secondary),
    );
    await i.reply({ embeds: [spEmbed], components: [spRow1, spRow2], flags: 64 });
    return;
  }

  if (commandName === "embed") {
    if (!guild) return;
    const member = i.member as GuildMember;
    if (!isMod(member)) {
      await i.reply({ embeds: [errEmbed("Only moderators can use this command.")], flags: 64 });
      return;
    }
    const colorRaw = i.options.getString("color", true).trim();
    const channelIdOpt = i.options.getString("channel_id", false)?.trim();
    const targetChannelId = channelIdOpt ?? channel?.id ?? "";

    const parsed = parseInt(colorRaw.replace(/^#/, ""), 16);
    if (isNaN(parsed)) {
      await i.reply({ embeds: [errEmbed("Invalid color. Use a hex code like `#ff0000`.")], flags: 64 });
      return;
    }

    if (!guild.channels.cache.get(targetChannelId)) {
      await i.reply({ embeds: [errEmbed("Could not find that channel.")], flags: 64 });
      return;
    }

    const safeColor = colorRaw.replace(/[^a-fA-F0-9#]/g, "").slice(0, 7);
    const modal = new ModalBuilder()
      .setCustomId(`embed_create:${safeColor}:${targetChannelId}`)
      .setTitle("Embed Builder")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("embed_title")
            .setLabel("Title (optional)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(256),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("embed_body")
            .setLabel("Body text — use \\n for new lines")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(4000),
        ),
      );

    await i.showModal(modal);
    return;
  }

  if (commandName === "reactionrole") {
    if (!guild) return;
    const member = i.member as GuildMember;
    if (!isMod(member)) {
      await i.reply({ embeds: [errEmbed("Only moderators can manage reaction roles.")], flags: 64 });
      return;
    }
    const sub = i.options.getSubcommand();

    if (sub === "add") {
      const messageId = i.options.getString("message_id", true).trim();
      const emojiRaw = i.options.getString("emoji", true).trim();
      const role = i.options.getRole("role", true);
      const channelIdOpt = i.options.getString("channel_id", false)?.trim();
      const targetChannelId = channelIdOpt ?? channel?.id ?? "";

      const targetChannel = guild.channels.cache.get(targetChannelId) as TextChannel | undefined;
      if (!targetChannel) {
        await i.reply({ embeds: [errEmbed("Could not find that channel. Make sure the bot can see it.")], flags: 64 });
        return;
      }

      if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });
      let targetMessage: Message | null = null;
      try {
        targetMessage = await targetChannel.messages.fetch(messageId);
      } catch {
        await i.editReply({ embeds: [errEmbed("Could not find that message. Make sure the message ID and channel are correct.")] });
        return;
      }

      try {
        await targetMessage.react(emojiRaw);
      } catch {
        await i.editReply({ embeds: [errEmbed(`Could not react with **${emojiRaw}**. Make sure it's a valid emoji the bot has access to.`)] });
        return;
      }

      storage.addReactionRole({
        messageId,
        channelId: targetChannelId,
        guildId: guild.id,
        emoji: emojiRaw,
        roleId: role.id,
      });

      await i.editReply({
        embeds: [okEmbed(`✅ Reaction role set up!\n\n**Message:** [Jump](https://discord.com/channels/${guild.id}/${targetChannelId}/${messageId})\n**Emoji:** ${emojiRaw}\n**Role:** <@&${role.id}>\n\nMembers who click ${emojiRaw} will get the role. Removing the reaction removes it.`)],
      });
      return;
    }

    if (sub === "remove") {
      const messageId = i.options.getString("message_id", true).trim();
      const emojiRaw = i.options.getString("emoji", true).trim();

      const entry = storage.getReactionRole(messageId, emojiRaw);
      if (!entry) {
        await i.reply({ embeds: [errEmbed("No reaction role found for that message + emoji combo.")], flags: 64 });
        return;
      }

      if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });

      storage.removeReactionRole(messageId, emojiRaw);

      const targetChannel = guild.channels.cache.get(entry.channelId) as TextChannel | undefined;
      if (targetChannel) {
        try {
          const msg = await targetChannel.messages.fetch(messageId);
          const reaction = msg.reactions.cache.find((r) => {
            const id = r.emoji.id ? `<:${r.emoji.name}:${r.emoji.id}>` : r.emoji.name;
            return id === emojiRaw || r.emoji.name === emojiRaw;
          });
          if (reaction) await reaction.remove();
        } catch {}
      }

      await i.editReply({ embeds: [okEmbed(`Reaction role for ${emojiRaw} removed.`)] });
      return;
    }

    if (sub === "list") {
      const all = storage.getAllReactionRoles();
      if (all.length === 0) {
        await i.reply({ embeds: [infoEmbed("No reaction roles configured.")], flags: 64 });
        return;
      }
      const lines = all.map((r) =>
        `**Message:** \`${r.messageId}\` | **Emoji:** ${r.emoji} | **Role:** <@&${r.roleId}> | **Channel:** <#${r.channelId}>`,
      );
      await i.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(`Reaction Roles (${all.length})`)
            .setDescription(lines.join("\n"))
            .setTimestamp(),
        ],
        flags: 64,
      });
      return;
    }
  }
}

// ─── Message → Interaction Adapter ──────────────────────────────────────────
// Wraps a Message so handleCommand() can be called from ! prefix commands.

type MsgOptMap = {
  strings?:  Record<string, string | null>;
  users?:    Record<string, User | null>;
  members?:  Record<string, GuildMember | null>;
  integers?: Record<string, number | null>;
  subcommand?: string;
};

class MsgCtx {
  commandName: string;
  user: User;
  guild: Guild | null;
  channel: TextChannel | null;
  channelId: string;
  guildId: string | null;
  member: GuildMember | null;
  options: {
    getString(name: string, req?: boolean): string | null;
    getUser(name: string, req?: boolean): User | null;
    getMember(name: string): GuildMember | null;
    getInteger(name: string, req?: boolean): number | null;
    getSubcommand(req?: boolean): string;
  };

  private _msg: Message;
  private _pending: Message | null = null;

  constructor(msg: Message, commandName: string, opts: MsgOptMap) {
    this.commandName = commandName;
    this.user        = msg.author;
    this.guild       = msg.guild;
    this.channel     = msg.channel as TextChannel;
    this.channelId   = msg.channelId;
    this.guildId     = msg.guildId;
    this.member      = msg.member;
    this._msg        = msg;
    this.options = {
      getString:     (name) => opts.strings?.[name]  ?? null,
      getUser:       (name) => opts.users?.[name]    ?? null,
      getMember:     (name) => opts.members?.[name]  ?? null,
      getInteger:    (name) => opts.integers?.[name] ?? null,
      getSubcommand: ()     => opts.subcommand ?? "",
    };
  }

  async deferReply(_opts?: unknown) {
    // No-op for message commands — we reply directly when ready
  }

  async editReply(payload: Record<string, unknown>) {
    const { flags: _f, ...rest } = payload;
    await (this._msg.channel as TextChannel).send(rest as MessageCreateOptions).catch(() => {});
  }

  async reply(payload: Record<string, unknown>) {
    const { flags: _f, ...rest } = payload;
    await this._msg.reply(rest as ReplyOptions).catch(() => {});
  }

  async followUp(payload: Record<string, unknown>) {
    const { flags: _f, ...rest } = payload;
    await (this._msg.channel as TextChannel).send(rest as MessageCreateOptions).catch(() => {});
  }

  async showModal(_modal: unknown) {
    await this._msg.reply({
      embeds: [errEmbed("This action requires the slash command — use `/giveaway create` instead.")],
    }).catch(() => {});
  }
}

async function routeMessageCommand(msg: Message, cmd: string, args: string[]): Promise<boolean> {
  if (!msg.guild) return false;
  const guild          = msg.guild;
  const mentioned      = msg.mentions.users.first() ?? null;
  const mentionedMember = mentioned ? (guild.members.cache.get(mentioned.id) ?? null) : null;
  // Strip leading mention tokens so positional text args work cleanly
  const restArgs = args.filter((a) => !a.startsWith("<@"));

  let commandName: string;
  let opts: MsgOptMap;

  switch (cmd) {
    case "stats": {
      if (!args[0]) {
        await msg.reply({ embeds: [errEmbed("Usage: `!stats <username>`")] }).catch(() => {});
        return true;
      }
      commandName = "stats";
      opts = { strings: { username: args[0] } };
      break;
    }
    default:
      return false;
  }

  const ctx = new MsgCtx(msg, commandName, opts);
  await handleCommand(ctx as unknown as ChatInputCommandInteraction).catch((e) => {
    logger.error({ err: e }, `!${cmd} error`);
  });
  return true;
}

async function handleButton(i: ButtonInteraction) {
  const { customId, user, guild } = i;

  // ─── Giveaway: Enter ────────────────────────────────────────────────────
  if (customId.startsWith("giveaway_enter_")) {
    const gwId = customId.slice("giveaway_enter_".length);
    const gw = storage.getGiveaway(gwId);
    if (!gw) {
      await i.reply({ embeds: [errEmbed("Giveaway not found. It may have been deleted.")], flags: 64 });
      return;
    }
    if (gw.ended) {
      await i.reply({ embeds: [errEmbed("This giveaway has already ended.")], flags: 64 });
      return;
    }
    const member = i.member as GuildMember | null;
    if (member?.roles.cache.has(BLACKLISTED_ROLE_ID)) {
      await i.reply({ embeds: [errEmbed("You are not allowed to enter giveaways.")], flags: 64 });
      return;
    }
    const alreadyIn = gw.entries.includes(user.id);
    if (alreadyIn) {
      const left = storage.leaveGiveaway(gwId, user.id);
      if (left) {
        const updated = storage.getGiveaway(gwId)!;
        try {
          const msg = await (i.channel as TextChannel).messages.fetch(gw.messageId);
          await msg.edit({ embeds: [buildGiveawayEmbed(updated)], components: msg.components as never });
        } catch {}
        await i.reply({ embeds: [infoEmbed("You have left the giveaway.")], flags: 64 });
      } else {
        await i.reply({ embeds: [infoEmbed("You were not in this giveaway.")], flags: 64 });
      }
    } else {
      const entered = storage.enterGiveaway(gwId, user.id);
      if (entered) {
        const updated = storage.getGiveaway(gwId)!;
        try {
          const msg = await (i.channel as TextChannel).messages.fetch(gw.messageId);
          await msg.edit({ embeds: [buildGiveawayEmbed(updated)], components: msg.components as never });
        } catch {}
        await i.reply({ embeds: [okEmbed("You have entered the giveaway! Click again to leave.")], flags: 64 });
      } else {
        await i.reply({ embeds: [errEmbed("Could not enter the giveaway. It may have just ended — please try again.")], flags: 64 });
      }
    }
    return;
  }

  // ─── Giveaway: Double It ────────────────────────────────────────────────
  if (customId.startsWith("giveaway_double_")) {
    const parts = customId.slice("giveaway_double_".length).split("_");
    const winnerId = parts.pop()!;
    const gwId = parts.join("_");
    const gw = storage.getGiveaway(gwId);

    if (!gw) { await i.reply({ embeds: [errEmbed("Giveaway not found.")], flags: 64 }); return; }
    if (user.id !== winnerId) { await i.reply({ embeds: [errEmbed("Only the winner can use this.")], flags: 64 }); return; }
    if (gw.claimedBy.includes(user.id)) { await i.reply({ embeds: [errEmbed("You have already claimed this prize.")], flags: 64 }); return; }
    if (gw.claimExpiry && new Date() > new Date(gw.claimExpiry)) { await i.reply({ embeds: [errEmbed("The claim period has expired.")], flags: 64 }); return; }

    const doubled = doublePrize(gw.prize);

    // Mark as claimed so they can't come back and claim after doubling
    storage.claimGiveaway(gwId, user.id);

    // Disable buttons on the winner's message
    await i.update({
      content: i.message.content,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("giveaway_claim_expired")
            .setLabel("Doubled")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
        ),
      ],
    });

    // Announce in channel
    await (i.channel as TextChannel).send({
      content: `**${user.displayName}** has doubled it! The new prize is **${doubled}**`,
    });
    return;
  }

  // ─── Giveaway: Claim ────────────────────────────────────────────────────
  if (customId.startsWith("giveaway_claim_") && customId !== "giveaway_claim_expired") {
    const parts = customId.slice("giveaway_claim_".length).split("_");
    const winnerId = parts.pop()!;
    const gwId = parts.join("_");
    const gw = storage.getGiveaway(gwId);

    if (!gw) { await i.reply({ embeds: [errEmbed("Giveaway not found.")], flags: 64 }); return; }
    const claimMember = i.member as GuildMember | null;
    if (claimMember?.roles.cache.has(BLACKLISTED_ROLE_ID)) {
      await i.reply({ embeds: [errEmbed("You are not allowed to claim giveaway prizes.")], flags: 64 });
      return;
    }
    if (user.id !== winnerId) {
      await i.reply({ embeds: [errEmbed("Only the winner can claim this prize.")], flags: 64 }); return;
    }
    if (gw.claimedBy.includes(user.id)) {
      await i.reply({ embeds: [errEmbed("You have already claimed this prize.")], flags: 64 }); return;
    }
    if (gw.claimExpiry && new Date() > new Date(gw.claimExpiry)) {
      await i.reply({ embeds: [errEmbed("The claim period has expired.")], flags: 64 }); return;
    }

    if (!guild) return;
    if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });

    const claimed = storage.claimGiveaway(gwId, user.id);
    if (!claimed) {
      const freshGw = storage.getGiveaway(gwId);
      if (freshGw?.claimExpiry && new Date() > new Date(freshGw.claimExpiry)) {
        await i.editReply({ embeds: [errEmbed("The claim period has expired.")] });
      } else if (freshGw?.claimedBy.includes(user.id)) {
        await i.editReply({ embeds: [errEmbed("You have already claimed this prize.")] });
      } else {
        await i.editReply({ embeds: [errEmbed("Could not process claim.")] });
      }
      return;
    }

    // Disable the claim button on the win message
    try {
      const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`giveaway_claim_done`)
          .setLabel("Claimed ✓")
          .setStyle(ButtonStyle.Success)
          .setDisabled(true),
      );
      await i.message.edit({ content: i.message.content, components: [disabledRow] });
    } catch {}

    // Create a giveaway claim ticket channel
    const claimExpiry = gw.claimExpiry ? Math.floor(new Date(gw.claimExpiry).getTime() / 1000) : null;
    let claimCategory = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === "Giveaway Tickets",
    ) as CategoryChannel | undefined;
    if (!claimCategory) {
      claimCategory = await guild.channels.create({
        name: "Giveaway Tickets",
        type: ChannelType.GuildCategory,
        permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
      });
    }

    const ticketNum = storage.nextTicketNumber();
    const safeName = user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "user";
    const safePrize = gw.prize.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "prize";
    const ticketChannel = await guild.channels.create({
      name: `giveaway-${safeName}-${safePrize}`,
      type: ChannelType.GuildText,
      parent: claimCategory.id,
      topic: `Giveaway Claim | ${gw.prize} | ${user.tag}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
          ],
        },
        {
          id: guild.members.me!.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageMessages,
          ],
        },
      ],
    });

    const claimEmbed = new EmbedBuilder()
      .setColor(SUCCESS_COLOR)
      .setTitle(`Giveaway Claim: ${ticketTag(ticketNum)}`)
      .setDescription("Welcome! Staff will process your giveaway prize shortly.")
      .addFields(
        { name: "Prize",       value: gw.prize,             inline: true },
        { name: "Winner",      value: `<@${user.id}>`,      inline: true },
        { name: "Giveaway ID", value: `\`${gw.id}\``,       inline: true },
        { name: "Claimed in Time", value: "✅", inline: true },
      )
      
      .setTimestamp();

    await ticketChannel.send({
      content: `<@${user.id}>`,
      embeds: [claimEmbed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("ticket_close").setLabel("Close Ticket").setStyle(ButtonStyle.Danger),
        ),
      ],
    });

    storage.addTicket(ticketChannel.id, {
      userId: user.id,
      username: user.username,
      categoryId: "giveaway-claim",
      guildId: guild.id,
      channelId: ticketChannel.id,
      createdAt: new Date().toISOString(),
      ticketNumber: ticketNum,
      giveawayId: gwId,
    });

    const logCh = guild.channels.cache.get(TICKET_LOG_CHANNEL_ID) as TextChannel | undefined;
    if (logCh) {
      const joinEmbed = new EmbedBuilder()
        .setColor(SUCCESS_COLOR)
        .setTitle("Giveaway Claim Ticket")
        .setDescription(`A giveaway claim ticket has been opened.`)
        .addFields(
          { name: "Winner",  value: `<@${user.id}>`, inline: true },
          { name: "Prize",   value: gw.prize,        inline: true },
          { name: "ID",      value: `\`${gw.id}\``,  inline: true },
          { name: "Staff In Ticket", value: "0",           inline: true },
        )
        
        .setTimestamp();
      await logCh.send({
        embeds: [joinEmbed],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`join_ticket_${ticketChannel.id}`)
              .setLabel("+ Join Ticket")
              .setStyle(ButtonStyle.Primary),
          ),
        ],
      }).catch(() => {});
    }

    await i.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(SUCCESS_COLOR)
          .setDescription(`Your claim ticket has been created: <#${ticketChannel.id}>`)
          ,
      ],
    });
    return;
  }

  if (customId.startsWith("ticket_btn_")) {
    const categoryId = customId.slice("ticket_btn_".length);
    if (!guild) return;

    if (categoryId === "skellys") {
      const existingId = storage.hasOpenTicket(user.id, "skellys", guild.id);
      if (existingId && guild.channels.cache.get(existingId)) {
        await i.reply({
          embeds: [new EmbedBuilder().setColor(WARNING_COLOR).setDescription(`You already have an open skelly ticket: <#${existingId}>`)],
          flags: 64,
        });
        return;
      }
      await i.reply({
        embeds: [new EmbedBuilder().setColor(SKELLY_CATEGORY.color).setTitle("Spawner Tickets").setDescription(`${getSkellyPriceText()}\n\nChoose an option below:`)],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("skelly_buy").setLabel("Buy Spawners").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("skelly_sell").setLabel("Sell Spawners").setStyle(ButtonStyle.Primary),
          ),
        ],
        flags: 64,
      });
      return;
    }

    await handleTicketCreate(i, categoryId, false);
    return;
  }

  if (customId === "staff_apply") {
    const bl1 = storage.getAppBlacklist(user.id);
    if (bl1) {
      await i.reply({ embeds: [errEmbed(`You are blacklisted from submitting applications.\n**Reason:** ${bl1.reason}`)], flags: 64 });
      return;
    }
    if (activeStaffApplications.has(user.id)) {
      await i.reply({
        embeds: [errEmbed("You already have an application in progress. Please check your DMs.")],
        flags: 64,
      });
      return;
    }
    activeStaffApplications.add(user.id);
    await i.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(BOT_COLOR)
          .setTitle("Application Started")
          .setDescription("Please **check your DMs** — the application will be conducted there.\n\nMake sure you have DMs enabled from server members."),
      ],
      flags: 64,
    });
    void runStaffApplication(user, guild!);
    return;
  }

  if (customId.startsWith("staff_accept_")) {
    const applicantId = customId.slice("staff_accept_".length);
    await i.deferUpdate();
    try {
      const applicant = await i.client.users.fetch(applicantId);
      const dm = await applicant.createDM();
      await dm.send({
        content:
          `**Congratulations, your application has been accepted!**\n\n` +
          `We're thrilled to welcome you to the **Bluqo's Bot** staff team!\n\n` +
          `A member of leadership will be reaching out to you shortly with next steps and everything you need to get started. ` +
          `In the meantime, please make sure you're active in the server and ready to begin.\n\n` +
          `Welcome aboard, we're excited to have you.`,
      });
      await i.editReply({
        embeds: [
          ...(i.message.embeds ?? []),
          new EmbedBuilder().setColor(SUCCESS_COLOR).setDescription(`**Accepted** by <@${user.id}>. Applicant has been notified.`),
        ],
        components: [],
      });
    } catch {
      await i.followUp({ embeds: [errEmbed("Could not DM the applicant. They may have DMs disabled.")], flags: 64 });
    }
    return;
  }

  if (customId.startsWith("staff_deny_")) {
    const applicantId = customId.slice("staff_deny_".length);
    await i.deferUpdate();
    try {
      const applicant = await i.client.users.fetch(applicantId);
      const dm = await applicant.createDM();
      await dm.send({
        content:
          `**Regarding Your Staff Application - Bluqo's Bot**\n\n` +
          `After careful review, we've decided not to move forward with your application at this time.\n\n` +
          `Please don't be discouraged, this isn't a permanent decision. ` +
          `You are welcome to reapply in **1 week**, and we encourage you to use that time to stay active, ` +
          `engage with the community, and continue growing.\n\n` +
          `Thank you for your interest in the team. We genuinely appreciate the effort you put into applying.`,
      });
      await i.editReply({
        embeds: [
          ...(i.message.embeds ?? []),
          new EmbedBuilder().setColor(ERROR_COLOR).setDescription(`**Denied** by <@${user.id}>. Applicant has been notified.`),
        ],
        components: [],
      });
    } catch {
      await i.followUp({ embeds: [errEmbed("Could not DM the applicant. They may have DMs disabled.")], flags: 64 });
    }
    return;
  }

  // ── /requestinvite accept/deny ────────────────────────────────────────────
  if (customId.startsWith("requestinvite_accept_") || customId.startsWith("requestinvite_deny_")) {
    if (!guild || !i.channel) return;
    const member = i.member as GuildMember;
    if (!isStaff(member)) {
      await i.reply({ embeds: [errEmbed("Only staff can accept or deny invite requests.")], flags: 64 });
      return;
    }
    const targetId = customId.startsWith("requestinvite_accept_")
      ? customId.slice("requestinvite_accept_".length)
      : customId.slice("requestinvite_deny_".length);
    const isDeny = customId.startsWith("requestinvite_deny_");

    if (isDeny) {
      await i.update({
        embeds: [
          ...(i.message.embeds ?? []),
          new EmbedBuilder().setColor(ERROR_COLOR).setDescription(`❌ Denied by <@${user.id}>.`),
        ],
        components: [],
      });
      return;
    }

    // Accept — add the user to the ticket channel
    const ticket = storage.getTicket(i.channel.id);
    if (!ticket) { await i.reply({ embeds: [errEmbed("Not a ticket channel.")], flags: 64 }); return; }
    const ch = i.channel as TextChannel;
    await ch.permissionOverwrites.edit(targetId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
      EmbedLinks: true,
      UseApplicationCommands: true,
    }).catch(() => {});
    await i.update({
      embeds: [
        ...(i.message.embeds ?? []),
        new EmbedBuilder().setColor(SUCCESS_COLOR).setDescription(`✅ <@${targetId}> has been added to the ticket by <@${user.id}>.`),
      ],
      components: [],
    });
    await ch.send({ content: `👋 <@${targetId}> has been invited into this ticket by <@${user.id}>.` }).catch(() => {});
    return;
  }

  if (customId === "ticket_close") {
    if (!guild || !i.channel) return;
    const ticket = storage.getTicket(i.channel.id);
    if (!ticket) { await i.reply({ embeds: [errEmbed("Not a ticket channel.")], flags: 64 }); return; }
    const member = i.member as GuildMember;
    if (!isStaff(member) && ticket.userId !== user.id) {
      await i.reply({ embeds: [errEmbed("No permission.")], flags: 64 }); return;
    }
    await i.reply({ embeds: [infoEmbed("Closing ticket in 5 seconds. A transcript will be saved.")] });
    await closeTicket(guild, ticket, i.channel as TextChannel, user.username, user.id, "No reason specified");
    setTimeout(async () => {
      storage.removeTicket(i.channel!.id);
      await (i.channel as TextChannel).delete("Ticket closed").catch(() => {});
    }, 5000);
    return;
  }

  if (customId.startsWith("show_transcript_")) {
    const ticketNumber = parseInt(customId.slice("show_transcript_".length), 10);
    const buf = storage.readTranscript(ticketNumber);
    if (!buf) {
      await i.reply({ embeds: [errEmbed("Transcript file not found.")], flags: 64 });
      return;
    }
    const file = new AttachmentBuilder(buf, { name: `transcript-${String(ticketNumber).padStart(4, "0")}.txt` });
    await i.reply({ files: [file], flags: 64 });
    return;
  }

  if (customId.startsWith("join_ticket_")) {
    const ticketChannelId = customId.slice("join_ticket_".length);
    if (!guild) return;
    const ticket = storage.getTicket(ticketChannelId);
    if (!ticket) { await i.reply({ embeds: [errEmbed("This ticket no longer exists.")], flags: 64 }); return; }
    const member = i.member as GuildMember;
    if (!isMod(member)) { await i.reply({ embeds: [errEmbed("You do not have the required moderator role.")], flags: 64 }); return; }

    const ticketCh = guild.channels.cache.get(ticketChannelId) as TextChannel | undefined;
    if (!ticketCh) { await i.reply({ embeds: [errEmbed("Ticket channel not found.")], flags: 64 }); return; }

    const joined = storage.joinTicket(ticketChannelId, user.id);
    if (!joined) {
      await i.reply({ embeds: [errEmbed("You have already joined this ticket.")], flags: 64 }); return;
    }

    await ticketCh.permissionOverwrites.edit(user.id, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true,
    }).catch(() => {});

    const updatedTicket = storage.getTicket(ticketChannelId);
    const staffCount = updatedTicket?.joinedStaff?.length ?? 1;

    const oldEmbed = i.message.embeds[0];
    if (oldEmbed) {
      const updatedEmbed = EmbedBuilder.from(oldEmbed);
      const fields = (updatedEmbed.data.fields ?? []).map((f) =>
        f.name === "👤 Staff In Ticket" ? { ...f, value: String(staffCount) } : f,
      );
      updatedEmbed.setFields(fields);
      await i.update({ embeds: [updatedEmbed], components: i.message.components as never }).catch(() => {});
    } else {
      await i.deferUpdate().catch(() => {});
    }

    await ticketCh.send({ embeds: [okEmbed(`<@${user.id}> has joined the ticket.`)] }).catch(() => {});
    return;
  }

  if (customId.startsWith("farm_accept_")) {
    const ticketChannelId = customId.slice("farm_accept_".length);
    if (!guild) return;
    if (!isOwner(user.id)) {
      await i.reply({ embeds: [errEmbed("Only the owner can accept farm requests.")], flags: 64 });
      return;
    }
    const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ticket_close").setLabel("Close Ticket").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(customId).setLabel(`Accepted by ${user.username}`).setStyle(ButtonStyle.Success).setDisabled(true),
    );
    await i.update({ components: [disabledRow] });
    const ticketCh = guild.channels.cache.get(ticketChannelId) as TextChannel | undefined;
    if (ticketCh) {
      await ticketCh.send({
        embeds: [
          new EmbedBuilder()
            .setColor(SUCCESS_COLOR)
            .setDescription(`✅ **<@${user.id}> has accepted this farm request.**\nBuilders can now claim this ticket.`)
            
            .setTimestamp(),
        ],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("ticket_claim").setLabel("Claim Ticket").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("ticket_close").setLabel("Close Ticket").setStyle(ButtonStyle.Danger),
          ),
        ],
      }).catch(() => {});
    }
    return;
  }

  if (customId === "set_build_price" || customId === "farm_change_price") {
    if (!guild || !i.channel) return;
    const ticket = storage.getTicket(i.channel.id);
    if (!ticket) { await i.reply({ embeds: [errEmbed("Not a build ticket.")], flags: 64 }); return; }
    if (ticket.claimedById !== user.id) {
      await i.reply({ embeds: [errEmbed("Only the builder who claimed this ticket can set the price.")], flags: 64 });
      return;
    }
    const modal = new ModalBuilder().setCustomId("mod_build_price").setTitle("Set Build Price");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("price")
          .setLabel("Agreed price")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 500M, 1.5B, 250000")
          .setRequired(true),
      ),
    );
    await i.showModal(modal);
    return;
  }

  if (customId.startsWith("build_confirm_price_")) {
    const channelId = customId.slice("build_confirm_price_".length);
    const pending = pendingPriceConfirms.get(channelId);
    if (!pending) {
      await i.reply({ embeds: [errEmbed("Price confirmation expired. Ask the builder to set it again.")], flags: 64 }); return;
    }
    const ticket = storage.getTicket(channelId);
    if (!ticket) { await i.reply({ embeds: [errEmbed("Ticket not found.")], flags: 64 }); return; }
    if (ticket.userId !== user.id) {
      await i.reply({ embeds: [errEmbed("Only the ticket opener can confirm the price.")], flags: 64 }); return;
    }
    pendingPriceConfirms.delete(channelId);
    await i.deferUpdate();
    await i.editReply({
      embeds: [new EmbedBuilder().setColor(SUCCESS_COLOR).setDescription(`✅ <@${user.id}> confirmed the price: **${pending.priceStr}**`)],
      components: [],
    });
    const baseBalance = await fetchVaultBalance();
    await (i.channel as TextChannel).send({
      content: `<@${ticket.userId}>`,
      embeds: [buildPaymentEmbed(pending.price, pending.priceStr)],
    }).catch(() => {});
    if (baseBalance !== null && guild) {
      startPaymentPoll(channelId, guild.id, ticket.userId, pending.price, pending.priceStr, baseBalance);
    } else {
      logger.warn({ channelId }, "Could not fetch vault balance at confirm time — auto-detection skipped, payment message still sent");
    }
    return;
  }

  if (customId.startsWith("build_reject_price_")) {
    const channelId = customId.slice("build_reject_price_".length);
    pendingPriceConfirms.delete(channelId);
    await i.update({
      embeds: [new EmbedBuilder().setColor(WARNING_COLOR).setDescription(`<@${user.id}> rejected the proposed price. Builder, please set a new price using the **Set Price** button.`)],
      components: [],
    });
    return;
  }

  if (customId === "build_service_ticket") {
    await i.reply({
      embeds: [new EmbedBuilder().setColor(GOLD_COLOR).setTitle("Building Services").setDescription("Will you be using a **server schematic** or providing a **custom schematic**?")],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("build_srv_server").setLabel("Server Schematic").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("build_srv_custom").setLabel("Custom Schematic").setStyle(ButtonStyle.Secondary),
      )],
      flags: 64,
    });
    return;
  }

  if (customId === "build_srv_server") {
    const modal = new ModalBuilder().setCustomId("mod_farm_server").setTitle("Building Service: Server Schematic");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("which_schematic").setLabel("Which server schematic do you want?").setStyle(TextInputStyle.Short).setPlaceholder("e.g. Bone Block Farm, Cobble Farm...").setRequired(true)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("mined_space").setLabel("Do you have a mined out space? (Yes/No)").setStyle(TextInputStyle.Short).setPlaceholder("If No: $1,000 × number of blocks to mine").setRequired(true)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("due_date").setLabel("When is it due?").setStyle(TextInputStyle.Short).setPlaceholder("e.g. ASAP, 2 weeks, March 1st").setRequired(true)),
    );
    await i.showModal(modal);
    return;
  }

  if (customId === "build_srv_custom") {
    const modal = new ModalBuilder().setCustomId("mod_farm_custom").setTitle("Building Service: Custom Schematic");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("budget").setLabel("How much are you willing to spend?").setStyle(TextInputStyle.Short).setPlaceholder("e.g. $500, negotiable").setRequired(true)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("mined_space").setLabel("Do you have a mined out space? (Yes/No)").setStyle(TextInputStyle.Short).setPlaceholder("If No: $1,000 × number of blocks to mine").setRequired(true)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("due_date").setLabel("When is it due?").setStyle(TextInputStyle.Short).setPlaceholder("e.g. ASAP, 2 weeks, March 1st").setRequired(true)),
    );
    await i.showModal(modal);
    return;
  }

  if (customId === "dig_service_ticket") {
    const modal = new ModalBuilder().setCustomId("mod_dig_service").setTitle("Digging Service");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("dim_x").setLabel("X dimension (length)").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. 50")),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("dim_y").setLabel("Y dimension (depth)").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. 30")),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("dim_z").setLabel("Z dimension (width)").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. 50")),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("due_date").setLabel("When is it due?").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("e.g. ASAP, 2 weeks")),
    );
    await i.showModal(modal);
    return;
  }

  if (customId === "partnership_ticket") {
    if (!guild) return;
    if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });
    let discordCat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === "Partnership Tickets") as CategoryChannel | undefined;
    if (!discordCat) {
      discordCat = await guild.channels.create({
        name: "Partnership Tickets",
        type: ChannelType.GuildCategory,
        permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
      });
    }
    const ticketNum = storage.nextTicketNumber();
    const safeName  = user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 18) || "user";
    const ticketChannel = await guild.channels.create({
      name: `partner-${safeName}`,
      type: ChannelType.GuildText,
      parent: discordCat.id,
      topic: `Partnership Ticket | ${user.tag}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id,  deny: [PermissionFlagsBits.ViewChannel] },
        { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
        { id: guild.members.me!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
      ],
    });
    const welcomeEmbed = new EmbedBuilder()
      .setColor(BOT_COLOR)
      .setTitle(`🤝 Partnership Ticket: ${ticketTag(ticketNum)}`)
      .setDescription("Thanks for your interest in partnering with us!\n\nPlease describe your server, player count, and what you're looking for in a partnership. Staff will be with you shortly.")
      .addFields(
        { name: "Opened by", value: `<@${user.id}>`, inline: true },
        { name: "Ticket",    value: ticketTag(ticketNum), inline: true },
      )
      .setTimestamp();
    await ticketChannel.send({
      content: `<@${user.id}>`,
      embeds: [welcomeEmbed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ticket_close").setLabel("Close Ticket").setStyle(ButtonStyle.Danger),
      )],
    });
    storage.addTicket(ticketChannel.id, { userId: user.id, username: user.username, categoryId: "partnership", guildId: guild.id, channelId: ticketChannel.id, createdAt: new Date().toISOString(), ticketNumber: ticketNum });
    await i.editReply({ embeds: [okEmbed(`✅ Your partnership ticket has been created: <#${ticketChannel.id}>`)] });
    return;
  }

  if (customId === "skelly_buy" || customId === "skelly_sell") {
    const isBuying = customId === "skelly_buy";
    if (!guild) return;
    const existingId = storage.hasOpenTicket(user.id, "skellys", guild.id);
    if (existingId && guild.channels.cache.get(existingId)) {
      await i.reply({
        embeds: [new EmbedBuilder().setColor(WARNING_COLOR).setDescription(`You already have an open skelly ticket: <#${existingId}>`)],
        flags: 64,
      });
      return;
    }
    if (existingId) storage.removeTicket(existingId);
    const modal = new ModalBuilder()
      .setCustomId(isBuying ? "mod_skelly_buy" : "mod_skelly_sell")
      .setTitle(isBuying ? "Buy Spawners" : "Sell Spawners");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("spawner")
          .setLabel("What spawner?")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("e.g. Skeleton, Creeper, Iron Golem..."),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("amount")
          .setLabel(isBuying ? "How many do you want to buy?" : "How many do you want to sell?")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("e.g. 64"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("details")
          .setLabel("Additional details")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setPlaceholder("Price offer, IGN, anything else..."),
      ),
    );
    await i.showModal(modal);
    return;
  }

  if (customId === "ticket_claim") {
    if (!guild || !i.channel) return;
    const ticket = storage.getTicket(i.channel.id);
    if (!ticket) { await i.reply({ embeds: [errEmbed("Not a ticket channel.")], flags: 64 }); return; }
    const member = i.member as GuildMember;
    const isFarmBuilder = ticket.categoryId === "buy-farms" && member.roles.cache.has(BUILD_TICKET_ROLE_ID);
    const isSkellyStaff = ticket.categoryId === "skellys" && member.roles.cache.has(SKELLY_TICKET_ROLE_ID);
    const isGeneralStaff = !["skellys", "buy-farms", "digging"].includes(ticket.categoryId) && member.roles.cache.has(GENERAL_TICKET_ROLE_ID);
    if (!isStaff(member) && !isFarmBuilder && !isSkellyStaff && !isGeneralStaff) {
      await i.reply({ embeds: [errEmbed("You don't have permission to claim this ticket.")], flags: 64 }); return;
    }
    if (ticket.claimedById && !isOwner(user.id)) {
      await i.reply({ embeds: [errEmbed(`This ticket is already claimed by <@${ticket.claimedById}>.`)], flags: 64 }); return;
    }
    storage.claimTicket(i.channel.id, user.username, user.id);
    if (ticket.categoryId === "buy-farms") {
      const openerSafe = ticket.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 14) || "user";
      const claimerSafe = user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 14) || "builder";
      await (i.channel as TextChannel).setName(`build-${openerSafe}-${claimerSafe}`).catch(() => {});
    }
    if (ticket.categoryId === "buy-farms" || ticket.categoryId === "digging") {
      await i.reply({
        embeds: [okEmbed(`Ticket claimed by <@${user.id}>.`)],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("set_build_price").setLabel("💰 Set Price").setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    } else {
      await i.reply({ embeds: [okEmbed(`Ticket claimed by <@${user.id}>.`)] });
    }
    return;
  }

  if (customId.startsWith("edit_reason_")) {
    const [, , guildId, channelId, messageId] = customId.split("_");
    const modal = new ModalBuilder()
      .setCustomId(`mod_edit_reason_${guildId}_${channelId}_${messageId}`)
      .setTitle("Edit Close Reason");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("new_reason")
          .setLabel("New Reason")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500),
      ),
    );
    await i.showModal(modal);
    return;
  }

  if (!isOwner(user.id)) {
    if (customId.startsWith("panel_") || customId.startsWith("t_") || customId.startsWith("f_")) {
      await i.reply({ embeds: [errEmbed("Not authorized.")], flags: 64 }); return;
    }
  }

  switch (customId) {
    case "panel_back":
      await i.update({ embeds: [panelEmbed()], components: panelRows() }); return;

    case "panel_rules": {
      const ch = i.channel as TextChannel;
      await i.deferUpdate();
      const WHITE = 0xffffff;
      await ch.send({ embeds: [
        new EmbedBuilder().setColor(WHITE).setTitle("Bluqo's Bot Rules").addFields({ name: "Section 1 — The Preamble", value: ["────────────────────────────", "By joining (and participating in this server), you agree to follow all established rules, including any updates or changes made in the future.", "", "Please keep your direct messages enabled. If disciplinary action is taken against you, staff will contact you with the reason for the punishment.", "", "The rules listed here are not exhaustive. Staff retain full authority to address behavior that violates the spirit of the community, even if it is not specifically mentioned."].join("\n") }),
      ] });
      await ch.send({ embeds: [
        new EmbedBuilder().setColor(WHITE).addFields({ name: "Section 2 — Terms and Services", value: ["────────────────────────────", "You must listen to [Discord's Terms of Service](https://discord.com/terms) at all times.", "", "By being part of this server, you agree to follow Discord's Community Guidelines to help maintain a safe and respectful environment.", "", "**To join the official V4 server, you must be at least 13 years old.**", "", "Do not discuss, promote, or admit to violating Discord's Terms of Service (e.g., scamming, distributing malicious content, evading bans).", "", "Any content that violates Discord's Terms of Service or Community Guidelines will be removed and may result in disciplinary action, including a ban. This includes, but is not limited to: harassment, scams, malicious links, or sharing inappropriate content."].join("\n") }),
      ] });
      await ch.send({ embeds: [
        new EmbedBuilder().setColor(WHITE).addFields(
          { name: "Section 3 — Guidelines (3.1–3.4)", value: ["────────────────────────────", "**3.1 No Direct or Indirect Threats** – Any threats involving DDoS, doxxing, violence, hacking, or harm toward another member are strictly prohibited. Even joking about these topics can result in action.", "", "**3.2 No Advertisements** – Promotion of other servers, communities, products, streams, or services is not allowed. Content may only be shared in approved channels if it is relevant and adds value.", "", "**3.3 Be Respectful at All Times** – Harassment, bullying, discrimination, or targeting other members will not be tolerated. Keep interactions mature and respectful.", "", "**3.4 No Pornographic or NSFW Content** – Explicit, adult, or otherwise inappropriate material is not permitted in any channel."].join("\n") },
          { name: "Section 3 — Guidelines (3.5–3.8)", value: ["**3.5 No Spamming or Flooding** – Avoid sending repeated messages, excessive emojis, all caps, or disrupting conversations with unnecessary content.", "", "**3.6 Appropriate Usernames & Profile Pictures** – Names and profile pictures must remain appropriate. Staff may require changes if something is considered offensive.", "", "**3.7 No Raiding or Raid Discussions** – Organizing, participating in, or even suggesting raids against this or other communities is forbidden.", "", "**3.8 Use Appropriate Language** – Keep profanity limited and never direct offensive, hateful, or discriminatory language toward others."].join("\n") },
        ),
      ] });
      await ch.send({ embeds: [
        new EmbedBuilder().setColor(WHITE).addFields({ name: "Section 4 — Reports", value: ["────────────────────────────", "All violations of these guidelines must be reported.", "", "**How to Report:**", "• Create a ticket in <#1450662193266692288>", "• Provide a detailed explanation of the incident.", "• Include clear evidence (screenshots, message links, etc.).", "• Provide the User ID(s) of the individual(s) involved — enable Developer Mode to obtain this."].join("\n") }).setFooter({ text: "Last Updated: June 2025" }),
      ] });
      await i.editReply({ embeds: [panelEmbed()], components: panelRows() }).catch(() => {});
      return;
    }

    case "panel_server": {
      if (!guild) return;
      const g = await guild.fetch();
      await g.members.fetch().catch(() => {});
      const online = g.members.cache.filter((m) => m.presence?.status !== "offline" && !!m.presence?.status).size;
      const embed = new EmbedBuilder()
        .setColor(BOT_COLOR)
        .setTitle(`Server Monitor: ${g.name}`)
        .setThumbnail(g.iconURL())
        .addFields(
          { name: "Members", value: `${g.memberCount}`, inline: true },
          { name: "Online", value: `${online || "N/A"}`, inline: true },
          { name: "Channels", value: `${g.channels.cache.size}`, inline: true },
          { name: "Roles", value: `${g.roles.cache.size}`, inline: true },
          { name: "Boosts", value: `${g.premiumSubscriptionCount ?? 0} (Level ${g.premiumTier})`, inline: true },
          { name: "Open Tickets", value: `${storage.getTicketsByGuild(g.id).length}`, inline: true },
          { name: "Owner", value: `<@${g.ownerId}>`, inline: true },
          { name: "Created", value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true },
        )
        
        .setTimestamp();
      await i.update({ embeds: [embed], components: [backRow("panel_back")] }); return;
    }

    case "panel_tickets": {
      const embed = new EmbedBuilder()
        .setColor(BOT_COLOR)
        .setTitle("Ticket Panel")
        .setDescription("Manage the ticket system. Send the ticket panel, edit category messages, or view active tickets.");
      await i.update({
        embeds: [embed],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("t_send").setLabel("Send Ticket Panel").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("t_edit").setLabel("Edit Messages").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("t_active").setLabel("Active Tickets").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("t_edit_text").setLabel("Edit Panel Text").setStyle(ButtonStyle.Secondary),
          ),
          backRow("panel_back"),
        ],
      }); return;
    }

    case "panel_farms": {
      const data = storage.getData();
      const embed = new EmbedBuilder()
        .setColor(GOLD_COLOR)
        .setTitle("Farm Panel")
        .addFields(
          { name: "Description", value: data.farmDescription?.slice(0, 900) || "No description set." },
          { name: "Farm List", value: data.farmList?.slice(0, 900) || "No farms listed." },
        );
      await i.update({
        embeds: [embed],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("f_send_panel").setLabel("Send Farm Ticket Panel").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("f_send_info").setLabel("Send Farm Info").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("f_edit_desc").setLabel("Edit Description").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("f_edit_list").setLabel("Edit Farm List").setStyle(ButtonStyle.Secondary),
          ),
          backRow("panel_back"),
        ],
      }); return;
    }

    case "panel_skelly": {
      const data = storage.getData();
      const embed = new EmbedBuilder()
        .setColor(BOT_COLOR)
        .setTitle("Skelly Panel")
        .addFields({ name: "Description", value: (data.skellyDescription || SKELLY_CATEGORY.description).slice(0, 900) });
      await i.update({
        embeds: [embed],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("sk_send_panel").setLabel("Send Skelly Panel").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("sk_edit_desc").setLabel("Edit Description").setStyle(ButtonStyle.Secondary),
          ),
          backRow("panel_back"),
        ],
      }); return;
    }

    case "t_send": {
      if (!i.channel) return;
      await i.deferUpdate();
      await (i.channel as TextChannel).send({ embeds: [ticketPanelEmbed()], components: ticketPanelComponents() });
      await i.editReply({ embeds: [okEmbed(`✅ Ticket panel sent to this channel.`)], components: [backRow("panel_tickets")] });
      return;
    }

    case "t_edit": {
      const options = REGULAR_CATEGORIES.map((cat) =>
        new StringSelectMenuOptionBuilder().setLabel(cat.label).setValue(cat.id).setDescription("Edit this category's message"),
      );
      const sel = new StringSelectMenuBuilder().setCustomId("sel_edit_cat").setPlaceholder("Choose a category").addOptions(options);
      await i.update({
        embeds: [new EmbedBuilder().setColor(BOT_COLOR).setTitle("Edit Category Messages").setDescription("Select a category to edit its welcome message.")],
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sel), backRow("panel_tickets")],
      }); return;
    }

    case "t_edit_text": {
      const data = storage.getData();
      const modal = new ModalBuilder().setCustomId("mod_panel_text").setTitle("Edit Ticket Panel Text");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("panel_title").setLabel("Title").setStyle(TextInputStyle.Short).setValue(data.ticketPanelTitle).setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("panel_desc").setLabel("Description").setStyle(TextInputStyle.Paragraph).setValue(data.ticketPanelDesc).setRequired(true),
        ),
      );
      await i.showModal(modal); return;
    }

    case "t_active": {
      if (!guild) return;
      const list = storage.getTicketsByGuild(guild.id);
      const embed = new EmbedBuilder()
        .setColor(BOT_COLOR)
        .setTitle(`Active Tickets: ${list.length} open`)
        .setDescription(
          list.length === 0
            ? "No open tickets."
            : list.slice(0, 20).map((t) => {
                const cat = ALL_CATEGORIES.find((c) => c.id === t.categoryId);
                return `**${ticketTag(t.ticketNumber)}** <#${t.channelId}> - ${cat?.label ?? t.categoryId} - <@${t.userId}> - <t:${Math.floor(new Date(t.createdAt).getTime() / 1000)}:R>`;
              }).join("\n"),
        )
        
        .setTimestamp();
      await i.update({ embeds: [embed], components: [backRow("panel_tickets")] }); return;
    }

    case "sk_send_panel": {
      if (!i.channel) return;
      await i.deferUpdate();
      const panelMsg = await (i.channel as TextChannel).send({ embeds: [skellyTicketPanelEmbed()], components: skellyTicketComponents() });
      storage.setSpawnerPanel(i.channel.id, panelMsg.id);
      await i.editReply({ embeds: [okEmbed("✅ Skelly ticket panel sent to this channel.")], components: [backRow("panel_skelly")] });
      return;
    }

    case "sk_edit_desc": {
      const modal = new ModalBuilder().setCustomId("mod_skelly_desc").setTitle("Edit Skelly Description");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("skelly_desc").setLabel("Description").setStyle(TextInputStyle.Paragraph).setValue(storage.getData().skellyDescription || SKELLY_CATEGORY.description).setRequired(true),
        ),
      );
      await i.showModal(modal); return;
    }

    case "f_send_panel": {
      if (!i.channel) return;
      await i.deferUpdate();
      await (i.channel as TextChannel).send({ embeds: [farmTicketPanelEmbed()], components: farmTicketComponents() });
      await i.editReply({ embeds: [okEmbed("✅ Farm ticket panel sent to this channel.")], components: [backRow("panel_farms")] });
      return;
    }

    case "f_send_info": {
      if (!i.channel) return;
      await i.deferUpdate();
      await (i.channel as TextChannel).send({ embeds: [farmInfoEmbed()] });
      await i.editReply({ embeds: [okEmbed("✅ Farm info sent to this channel.")], components: [backRow("panel_farms")] });
      return;
    }

    case "f_edit_desc": {
      const modal = new ModalBuilder().setCustomId("mod_farm_desc").setTitle("Edit Farm Description");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("farm_desc").setLabel("Description").setStyle(TextInputStyle.Paragraph).setValue(storage.getData().farmDescription).setRequired(true),
        ),
      );
      await i.showModal(modal); return;
    }

    case "f_edit_list": {
      const modal = new ModalBuilder().setCustomId("mod_farm_list").setTitle("Edit Farm List");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("farm_list").setLabel("Available Farms").setStyle(TextInputStyle.Paragraph).setValue(storage.getData().farmList).setRequired(true),
        ),
      );
      await i.showModal(modal); return;
    }

    case "panel_staff_app": {
      const embed = new EmbedBuilder()
        .setColor(0x5b8ef5)
        .setTitle("Staff Applications Panel")
        .setDescription("Send a standalone Staff Applications panel to any channel. Members click the button and complete the application via DM.");
      await i.update({
        embeds: [embed],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("sa_send_panel").setLabel("Send Staff App Panel").setStyle(ButtonStyle.Primary),
          ),
          backRow("panel_back"),
        ],
      }); return;
    }

    case "sa_send_panel": {
      if (!i.channel) return;
      await i.deferUpdate();
      await (i.channel as TextChannel).send({ embeds: [staffAppPanelEmbed()], components: staffAppPanelComponents() });
      await i.editReply({ embeds: [okEmbed("✅ Staff Application panel sent to this channel.")], components: [backRow("panel_staff_app")] });
      return;
    }
  }

  // ── Spam alert buttons ──────────────────────────────────────────────────────
  if (customId.startsWith("spam_ignore_")) {
    if (!isStaff(i.member as GuildMember)) { await i.reply({ embeds: [errEmbed("Staff only.")], flags: 64 }); return; }
    const alertId = customId.slice("spam_ignore_".length);
    pendingSpamAlerts.delete(alertId);
    await i.update({
      embeds: [new EmbedBuilder().setColor(0x555555).setDescription(`✅ Alert dismissed by <@${user.id}>.`)],
      components: [],
    });
    return;
  }

  if (customId.startsWith("spam_info_")) {
    if (!isStaff(i.member as GuildMember)) { await i.reply({ embeds: [errEmbed("Staff only.")], flags: 64 }); return; }
    const alertId = customId.slice("spam_info_".length);
    const alert = pendingSpamAlerts.get(alertId);
    if (!alert) { await i.reply({ embeds: [errEmbed("Alert expired.")], flags: 64 }); return; }
    const targetUser = await i.client.users.fetch(alert.userId).catch(() => null);
    const member = guild?.members.cache.get(alert.userId) ?? await guild?.members.fetch(alert.userId).catch(() => null);
    const embed = new EmbedBuilder()
      .setColor(BOT_COLOR)
      .setTitle("User Info")
      .setThumbnail(targetUser?.displayAvatarURL() ?? null)
      .addFields(
        { name: "Username", value: targetUser ? `${targetUser.username}` : alert.userId, inline: true },
        { name: "ID", value: `\`${alert.userId}\``, inline: true },
        { name: "Account Created", value: targetUser ? `<t:${Math.floor(targetUser.createdTimestamp / 1000)}:R>` : "Unknown", inline: true },
        { name: "Joined Server", value: member?.joinedAt ? `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:R>` : "Unknown", inline: true },
        { name: "Roles", value: member ? [...member.roles.cache.values()].filter((r) => r.id !== guild?.id).map((r) => `<@&${r.id}>`).join(", ").slice(0, 512) || "None" : "Unknown", inline: false },
        { name: "Warnings", value: `${storage.getWarns(alert.userId).length} / 5`, inline: true },
      )
      .setTimestamp();
    await i.reply({ embeds: [embed], flags: 64 });
    return;
  }

  if (customId.startsWith("spam_action_")) {
    if (!isStaff(i.member as GuildMember)) { await i.reply({ embeds: [errEmbed("Staff only.")], flags: 64 }); return; }
    const alertId = customId.slice("spam_action_".length);
    const alert = pendingSpamAlerts.get(alertId);
    if (!alert) { await i.reply({ embeds: [errEmbed("Alert expired.")], flags: 64 }); return; }
    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`spam_do_warn_${alertId}`).setLabel("⚠️ Warn").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`spam_do_kick_${alertId}`).setLabel("👢 Kick").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`spam_do_ban_${alertId}`).setLabel("🔨 Ban").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`spam_do_timeout_${alertId}`).setLabel("⏱️ Timeout 10m").setStyle(ButtonStyle.Secondary),
    );
    await i.reply({
      embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setTitle("Take Action").setDescription(`Choose an action for <@${alert.userId}>:`)],
      components: [actionRow],
      flags: 64,
    });
    return;
  }

  if (customId.startsWith("spam_do_")) {
    if (!isStaff(i.member as GuildMember)) { await i.reply({ embeds: [errEmbed("Staff only.")], flags: 64 }); return; }
    const withoutPrefix = customId.slice("spam_do_".length);
    const underscoreIdx = withoutPrefix.indexOf("_");
    const action = withoutPrefix.slice(0, underscoreIdx);
    const alertId = withoutPrefix.slice(underscoreIdx + 1);
    const alert = pendingSpamAlerts.get(alertId);
    if (!alert) { await i.reply({ embeds: [errEmbed("Alert expired.")], flags: 64 }); return; }
    if (!guild) { await i.reply({ embeds: [errEmbed("Guild not found.")], flags: 64 }); return; }
    const target = await guild.members.fetch(alert.userId).catch(() => null);
    if (!target) { await i.reply({ embeds: [errEmbed("Member not found (may have left).")], flags: 64 }); return; }

    if (action === "warn") {
      const warn: WarnEntry = { userId: alert.userId, reason: "Spam detected by AutoMod", moderatorId: user.id, moderatorTag: user.username, timestamp: new Date().toISOString() };
      const count = storage.addWarn(alert.userId, warn);
      pendingSpamAlerts.delete(alertId);
      await i.update({
        embeds: [new EmbedBuilder().setColor(WARNING_COLOR).setDescription(`<@${alert.userId}> warned for spam. **(${count}/5 warnings)**`)],
        components: [],
      });
      target.user.send({ embeds: [warnDmEmbed("Spamming", count, guild?.name ?? "Bluqo's Bot")] }).catch(() => {});
      if (count >= 5 && target.bannable) await target.ban({ reason: "Auto-ban: 5 warnings" }).catch(() => {});
    } else if (action === "kick") {
      if (!target.kickable) { await i.reply({ embeds: [errEmbed("I cannot kick this member.")], flags: 64 }); return; }
      await target.kick("Spam detected by AutoMod").catch(() => {});
      pendingSpamAlerts.delete(alertId);
      await i.update({
        embeds: [new EmbedBuilder().setColor(WARNING_COLOR).setDescription(`<@${alert.userId}> kicked for spam.`)],
        components: [],
      });
    } else if (action === "ban") {
      if (!target.bannable) { await i.reply({ embeds: [errEmbed("I cannot ban this member.")], flags: 64 }); return; }
      await target.ban({ reason: "Spam detected by AutoMod" }).catch(() => {});
      pendingSpamAlerts.delete(alertId);
      await i.update({
        embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(`<@${alert.userId}> banned for spam.`)],
        components: [],
      });
    } else if (action === "timeout") {
      await target.timeout(10 * 60 * 1000, "Spam detected by AutoMod").catch(() => {});
      pendingSpamAlerts.delete(alertId);
      await i.update({
        embeds: [new EmbedBuilder().setColor(WARNING_COLOR).setDescription(`<@${alert.userId}> timed out for 10 minutes for spam.`)],
        components: [],
      });
    }
    return;
  }

  // Spawner panel buttons
  if (customId === "sp_list") {
    if (!guild) return;
    if (!isStaff(i.member as GuildMember)) { await i.reply({ embeds: [errEmbed("Staff only.")], flags: 64 }); return; }
    const spawners = storage.getSpawners();
    const entries = Object.entries(spawners);
    if (entries.length === 0) {
      await i.reply({ embeds: [infoEmbed("No spawner types configured.")], flags: 64 }); return;
    }
    const spFields = entries.map(([name, s]) => ({
      name: `${name} Spawners`,
      value: `Buy: **${s.buyPrice ?? "N/A"}** | Sell: **${s.sellPrice ?? "N/A"}** | Stock: **${s.stock}**`,
      inline: false,
    }));
    await i.reply({ embeds: [new EmbedBuilder().setColor(SKELLY_CATEGORY.color).setTitle("Spawner Prices and Stock").addFields(...spFields).setTimestamp()], flags: 64 });
    return;
  }

  if (customId === "sp_add_stock" || customId === "sp_rem_stock") {
    if (!guild) return;
    if (!isStaff(i.member as GuildMember)) { await i.reply({ embeds: [errEmbed("Staff only.")], flags: 64 }); return; }
    const isAdd = customId === "sp_add_stock";
    const stockModal = new ModalBuilder()
      .setCustomId(isAdd ? "mod_sp_add_stock" : "mod_sp_rem_stock")
      .setTitle(isAdd ? "Add Spawner Stock" : "Remove Spawner Stock");
    stockModal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("sp_type").setLabel("Spawner Type (e.g. Skeleton, Iron Golem)").setStyle(TextInputStyle.Short).setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("sp_amount").setLabel("Amount").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. 5"),
      ),
    );
    await i.showModal(stockModal); return;
  }

  if (customId === "sp_set_price") {
    if (!guild) return;
    if (!isOwnerOrCoOwner(i.member as GuildMember)) { await i.reply({ embeds: [errEmbed("Only the Owner or Co-Owner can change prices.")], flags: 64 }); return; }
    const priceModal = new ModalBuilder().setCustomId("mod_sp_set_price").setTitle("Set Spawner Price");
    priceModal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("sp_type").setLabel("Spawner Type (e.g. Skeleton)").setStyle(TextInputStyle.Short).setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("sp_side").setLabel('Side: "buy" or "sell"').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("buy"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("sp_price").setLabel('Price (e.g. 3.3m) or "none" to remove').setStyle(TextInputStyle.Short).setRequired(true),
      ),
    );
    await i.showModal(priceModal); return;
  }

  if (customId === "sp_add_type") {
    if (!guild) return;
    if (!isOwnerOrCoOwner(i.member as GuildMember)) { await i.reply({ embeds: [errEmbed("Only the Owner or Co-Owner can add spawner types.")], flags: 64 }); return; }
    const addTypeModal = new ModalBuilder().setCustomId("mod_sp_add_type").setTitle("Add Spawner Type");
    addTypeModal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("sp_name").setLabel("Spawner Name (e.g. Blaze)").setStyle(TextInputStyle.Short).setRequired(true),
      ),
    );
    await i.showModal(addTypeModal); return;
  }

  if (customId === "sp_del_type") {
    if (!guild) return;
    if (!isOwnerOrCoOwner(i.member as GuildMember)) { await i.reply({ embeds: [errEmbed("Only the Owner or Co-Owner can delete spawner types.")], flags: 64 }); return; }
    const delTypeModal = new ModalBuilder().setCustomId("mod_sp_del_type").setTitle("Delete Spawner Type");
    delTypeModal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("sp_name").setLabel("Spawner Name to Delete").setStyle(TextInputStyle.Short).setRequired(true),
      ),
    );
    await i.showModal(delTypeModal); return;
  }
}

async function handleStringSelect(i: StringSelectMenuInteraction) {
  const { customId, values, user, guild } = i;

  if (customId === "sel_ticket_topic") {
    if (values[0] === "skellys") {
      if (!guild) return;
      const existingId = storage.hasOpenTicket(user.id, "skellys", guild.id);
      if (existingId && guild.channels.cache.get(existingId)) {
        await i.reply({
          embeds: [new EmbedBuilder().setColor(WARNING_COLOR).setDescription(`You already have an open skelly ticket: <#${existingId}>`)],
          flags: 64,
        });
        return;
      }
      await i.reply({
        embeds: [new EmbedBuilder().setColor(SKELLY_CATEGORY.color).setTitle("Spawner Tickets").setDescription(`${getSkellyPriceText()}\n\nChoose an option below:`)],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("skelly_buy").setLabel("Buy Spawners").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("skelly_sell").setLabel("Sell Spawners").setStyle(ButtonStyle.Primary),
          ),
        ],
        flags: 64,
      });
      return;
    }
    await handleTicketCreate(i, values[0]!, false);
    return;
  }

  if (customId === "sel_skelly_topic") {
    if (!guild) return;
    const existingId = storage.hasOpenTicket(user.id, "skellys", guild.id);
    if (existingId && guild.channels.cache.get(existingId)) {
      await i.reply({
        embeds: [new EmbedBuilder().setColor(WARNING_COLOR).setDescription(`You already have an open skelly ticket: <#${existingId}>`)],
        flags: 64,
      });
      return;
    }
    await i.reply({
      embeds: [new EmbedBuilder().setColor(SKELLY_CATEGORY.color).setTitle("Spawner Tickets").setDescription(`${getSkellyPriceText()}\n\nChoose an option below:`)],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("skelly_buy").setLabel("Buy Spawners").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("skelly_sell").setLabel("Sell Spawners").setStyle(ButtonStyle.Primary),
        ),
      ],
      flags: 64,
    });
    return;
  }

  if (customId === "sel_farm_topic") {
    const sel = new StringSelectMenuBuilder()
      .setCustomId("sel_farm_schematic")
      .setPlaceholder("Choose a schematic type")
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel("Which one?")
          .setValue("server")
          .setDescription("Use one of our pre-made server schematics"),
        new StringSelectMenuOptionBuilder()
          .setLabel("Custom Schematic")
          .setValue("custom")
          .setDescription("Bring your own custom schematic"),
      );
    await i.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(GOLD_COLOR)
          .setTitle("Buy Farms: Schematic Type")
          .setDescription("Will you be using a **server schematic** or providing a **custom schematic**?")
          ,
      ],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sel)],
      flags: 64,
    });
    return;
  }

  if (customId === "sel_farm_schematic") {
    const schematic = values[0]!;
    if (schematic === "server") {
      const modal = new ModalBuilder()
        .setCustomId("mod_farm_server")
        .setTitle("Buy Farms: Server Schematic");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("which_schematic")
            .setLabel("Which server schematic do you want?")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g. Bone Block Farm, Cobble Farm...")
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("mined_space")
            .setLabel("Do you have a mined out space? (Yes/No)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("If No: $1,000 × number of blocks to mine")
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("due_date")
            .setLabel("When is it due?")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g. ASAP, 2 weeks, March 1st")
            .setRequired(true),
        ),
      );
      await i.showModal(modal);
      return;
    }
    if (schematic === "custom") {
      const modal = new ModalBuilder()
        .setCustomId("mod_farm_custom")
        .setTitle("Buy Farms: Custom Schematic");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("budget")
            .setLabel("How much are you willing to spend?")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g. $500, negotiable, open to offers")
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("mined_space")
            .setLabel("Do you have a mined out space? (Yes/No)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("If No: $1,000 × number of blocks to mine")
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("due_date")
            .setLabel("When is it due?")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g. ASAP, 2 weeks, March 1st")
            .setRequired(true),
        ),
      );
      await i.showModal(modal);
      return;
    }
    return;
  }

  if (customId === "sel_edit_cat" && isOwner(user.id)) {
    const cat = ALL_CATEGORIES.find((c) => c.id === values[0]!);
    if (!cat) return;
    const current = storage.getCategoryMessage(cat.id) ?? cat.description;
    const modal = new ModalBuilder().setCustomId(`mod_cat_${cat.id}`).setTitle(`Edit: ${cat.label}`);
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("cat_message").setLabel("Welcome Message").setStyle(TextInputStyle.Paragraph).setValue(current).setRequired(true),
      ),
    );
    await i.showModal(modal);
    return;
  }
}

async function handleChannelSelect(i: ChannelSelectMenuInteraction) {
  const { customId, values, guild } = i;
  if (!guild || !isOwner(i.user.id)) return;
  const ch = guild.channels.cache.get(values[0]!) as TextChannel | undefined;
  if (!ch) return;

}

async function handleModal(i: ModalSubmitInteraction) {
  // Defer only if the handler takes > 1.5s.
  let _deferPromise: Promise<void> | null = null;
  const _deferTimer = setTimeout(() => {
    if (!i.replied && !i.deferred) {
      _deferPromise = i.deferReply({ flags: 64 }).catch(() => {});
    }
  }, 1500);
  const _origReply = i.reply.bind(i);
  (i as any).reply = async (opts: Parameters<typeof i.reply>[0]) => {
    clearTimeout(_deferTimer);
    if (_deferPromise) await _deferPromise;
    if (i.deferred && !i.replied) {
      const payload = (typeof opts === "string" ? { content: opts } : opts) as Record<string, unknown>;
      const { flags: _f, ...rest } = payload;
      return i.editReply(rest as any);
    }
    return _origReply(opts as any);
  };

  const { customId, user } = i;

  // ─── Embed Builder ───────────────────────────────────────────────────────
  if (customId.startsWith("embed_create:")) {
    const [, colorPart, channelId] = customId.split(":");
    const title = i.fields.getTextInputValue("embed_title").trim() || undefined;
    const bodyRaw = i.fields.getTextInputValue("embed_body");
    const body = bodyRaw.replace(/\\n/g, "\n");

    const colorNum = parseInt((colorPart ?? "").replace(/^#/, ""), 16);
    const guild = i.guild;
    if (!guild || !channelId) { await i.reply({ content: "Something went wrong.", flags: 64 }); return; }

    const targetChannel = guild.channels.cache.get(channelId) as TextChannel | undefined;
    if (!targetChannel) { await i.reply({ content: "Channel not found.", flags: 64 }); return; }

    const embed = new EmbedBuilder().setColor(isNaN(colorNum) ? 0x5865f2 : colorNum).setDescription(body);
    if (title) embed.setTitle(title);

    await targetChannel.send({ embeds: [embed] });
    await i.reply({ embeds: [okEmbed(`Embed sent in <#${channelId}>.`)], flags: 64 });
    return;
  }

  // ─── Giveaway Create ────────────────────────────────────────────────────
  if (customId === "mod_giveaway_create") {
    const prize = i.fields.getTextInputValue("prize").trim();
    const durationStr = i.fields.getTextInputValue("duration").trim();
    const winnersStr = i.fields.getTextInputValue("winners").trim();
    const typeRaw = i.fields.getTextInputValue("type").trim().toLowerCase();
    const gwType: "normal" | "simple" | "double" | "quickdrop" =
      typeRaw === "simple" ? "simple" : typeRaw === "double" ? "double" : typeRaw === "quickdrop" ? "quickdrop" : "normal";
    const description = i.fields.getTextInputValue("description").trim();

    const durationMs = parseDuration(durationStr);
    if (!durationMs) {
      await i.reply({ embeds: [errEmbed("Invalid duration. Use formats like `1h`, `30m`, `1d`, `2h30m`.")], flags: 64 });
      return;
    }

    if (gwType === "quickdrop") {
      const minMs = 30_000;           // 30 seconds
      const maxMs = 60 * 60 * 1000;  // 1 hour
      if (durationMs < minMs || durationMs > maxMs) {
        await i.reply({ embeds: [errEmbed("Quickdrop duration must be between **30 seconds** and **1 hour**.")], flags: 64 });
        return;
      }
    }

    const winnersCount = parseInt(winnersStr, 10);
    if (isNaN(winnersCount) || winnersCount < 1 || winnersCount > 20) {
      await i.reply({ embeds: [errEmbed("Invalid winner count. Must be between 1 and 20.")], flags: 64 });
      return;
    }

    if (!i.channel || !i.guild) {
      await i.reply({ embeds: [errEmbed("Could not determine channel.")], flags: 64 });
      return;
    }

    if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });

    const gwId = genGiveawayId();
    const endTime = new Date(Date.now() + durationMs).toISOString();

    const gw: GiveawayEntry = {
      id: gwId,
      guildId: i.guild.id,
      channelId: i.channel.id,
      messageId: "",
      hostId: user.id,
      prize,
      description,
      winnersCount,
      endTime,
      entries: [],
      ended: false,
      winners: [],
      claimedBy: [],
      claimExpiry: null,
      winMessages: {},
      type: gwType,
    };

    const enterRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`giveaway_enter_${gwId}`)
        .setLabel("🎉")
        .setStyle(ButtonStyle.Primary),
    );

    const msg = await (i.channel as TextChannel).send({
      embeds: [buildGiveawayEmbed(gw)],
      components: [enterRow],
    });

    gw.messageId = msg.id;
    storage.addGiveaway(gw);
    scheduleGiveaway(gw);

    await i.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(SUCCESS_COLOR)
          .setDescription(`✅ Giveaway created in <#${i.channel.id}>!\n\nPrize: **${prize}** | Winners: **${winnersCount}** | ID: \`${gwId}\``)
          ,
      ],
    });
    return;
  }

  if (customId === "mod_dig_service") {
    const { guild } = i;
    if (!guild) return;
    const dimX = parseFloat(i.fields.getTextInputValue("dim_x")) || 0;
    const dimY = parseFloat(i.fields.getTextInputValue("dim_y")) || 0;
    const dimZ = parseFloat(i.fields.getTextInputValue("dim_z")) || 0;
    const dueDate = i.fields.getTextInputValue("due_date").trim() || "ASAP";
    if (dimX <= 0 || dimY <= 0 || dimZ <= 0) {
      await i.reply({ embeds: [errEmbed("All dimensions must be positive numbers.")], flags: 64 }); return;
    }
    const totalBlocks = dimX * dimY * dimZ;
    const price = totalBlocks * 950;
    const existingId = storage.hasOpenTicket(user.id, "digging", guild.id);
    if (existingId && guild.channels.cache.get(existingId)) {
      await i.reply({ embeds: [new EmbedBuilder().setColor(WARNING_COLOR).setDescription(`You already have an open digging ticket: <#${existingId}>`)], flags: 64 }); return;
    }
    if (existingId) storage.removeTicket(existingId);
    if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });
    let discordCat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === "Digging Tickets") as CategoryChannel | undefined;
    if (!discordCat) {
      discordCat = await guild.channels.create({
        name: "Digging Tickets",
        type: ChannelType.GuildCategory,
        permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
      });
    }
    const ticketNum = storage.nextTicketNumber();
    const safeName  = user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 18) || "user";
    const ticketChannel = await guild.channels.create({
      name: `dig-${safeName}`,
      type: ChannelType.GuildText,
      parent: discordCat.id,
      topic: `Digging Ticket ${ticketTag(ticketNum)} | ${user.tag}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
        { id: guild.members.me!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
      ],
    });
    const welcomeEmbed = new EmbedBuilder()
      .setColor(SUCCESS_COLOR)
      .setTitle(`⛏️ Digging Service: ${ticketTag(ticketNum)}`)
      .setDescription("Thank you for ordering a digging service! A builder will claim this shortly.")
      .addFields(
        { name: "Opened by",       value: `<@${user.id}>`,                        inline: true },
        { name: "Ticket",          value: ticketTag(ticketNum),                    inline: true },
        { name: "Dimensions",      value: `${dimX} × ${dimY} × ${dimZ}`,          inline: true },
        { name: "Total Blocks",    value: `${fmtNum(totalBlocks)} blocks`,         inline: true },
        { name: "Estimated Price", value: `$${fmtNum(price)}`,                     inline: true },
        { name: "Due Date",        value: dueDate,                                 inline: true },
      )
      .setFooter({ text: `Formula: ${dimX} × ${dimY} × ${dimZ} × $950` })
      .setTimestamp();
    await ticketChannel.send({
      content: `<@${user.id}>`,
      embeds: [welcomeEmbed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ticket_claim").setLabel("Claim Ticket").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("ticket_close").setLabel("Close Ticket").setStyle(ButtonStyle.Danger),
      )],
    });
    storage.addTicket(ticketChannel.id, { userId: user.id, username: user.username, categoryId: "digging", guildId: guild.id, channelId: ticketChannel.id, createdAt: new Date().toISOString(), ticketNumber: ticketNum });
    await i.editReply({ embeds: [new EmbedBuilder().setColor(SUCCESS_COLOR).setTitle("⛏️ Digging Ticket Created").setDescription(`Your ticket: <#${ticketChannel.id}>\n\n**Estimated cost:** $${fmtNum(price)}\n\`${dimX} × ${dimY} × ${dimZ} × $950\``).setTimestamp()] });
    return;
  }

  if (customId === "mod_farm_server" || customId === "mod_farm_custom") {
    const { guild } = i;
    if (!guild) return;

    const isCustom       = customId === "mod_farm_custom";
    const dueDate        = i.fields.getTextInputValue("due_date");
    const budget         = isCustom ? i.fields.getTextInputValue("budget") : null;
    const whichSchematic = !isCustom ? i.fields.getTextInputValue("which_schematic") : null;
    const minedSpace     = i.fields.getTextInputValue("mined_space");

    const existingId = storage.hasOpenTicket(user.id, "buy-farms", guild.id);
    if (existingId && guild.channels.cache.get(existingId)) {
      await i.reply({
        embeds: [new EmbedBuilder().setColor(WARNING_COLOR).setDescription(`You already have an open farm ticket: <#${existingId}>`)],
        flags: 64,
      });
      return;
    }
    if (existingId) storage.removeTicket(existingId);

    if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });

    let discordCategory = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === FARM_CATEGORY.discordCategoryName,
    ) as CategoryChannel | undefined;
    if (!discordCategory) {
      discordCategory = await guild.channels.create({
        name: FARM_CATEGORY.discordCategoryName,
        type: ChannelType.GuildCategory,
        permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
      });
    }

    const ticketNum = storage.nextTicketNumber();
    const safeName  = user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 18) || "user";
    const channelName = `build-${safeName}`;

    const ticketChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: discordCategory.id,
      topic: `Ticket ${ticketTag(ticketNum)} | Buy Farms | ${user.tag}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: user.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks],
        },
        {
          id: guild.members.me!.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages],
        },
      ],
    });

    const schematicType = isCustom ? "Custom Schematic" : "Server Schematic";
    const welcomeFields: { name: string; value: string; inline: boolean }[] = [
      { name: "Opened by",      value: `<@${user.id}>`,    inline: true },
      { name: "Ticket",         value: ticketTag(ticketNum), inline: true },
      { name: "Schematic Type", value: schematicType,        inline: true },
    ];
    if (whichSchematic) {
      welcomeFields.push({ name: "Schematic",    value: whichSchematic, inline: true });
    }
    welcomeFields.push({ name: "Mined Out Space", value: `${minedSpace} (If No: $1,000 × blocks to mine)`, inline: true });
    welcomeFields.push({ name: "Due Date",         value: dueDate,                                          inline: true });
    if (isCustom && budget) {
      welcomeFields.push({ name: "Budget", value: budget, inline: true });
    }

    const customMsg = storage.getCategoryMessage("buy-farms") ?? FARM_CATEGORY.description;
    const welcomeEmbed = new EmbedBuilder()
      .setColor(SUCCESS_COLOR)
      .setTitle(`Buy Farms: ${ticketTag(ticketNum)}`)
      .setDescription(customMsg)
      .addFields(...welcomeFields)
      .setTimestamp();

    const controlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ticket_claim").setLabel("Claim Ticket").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ticket_close").setLabel("Close Ticket").setStyle(ButtonStyle.Danger),
    );

    await ticketChannel.send({
      content: `<@${user.id}> <@&${BUILD_TICKET_ROLE_ID}>`,
      embeds: [welcomeEmbed],
      components: [controlRow],
    });

    storage.addTicket(ticketChannel.id, {
      userId: user.id,
      username: user.username,
      categoryId: "buy-farms",
      guildId: guild.id,
      channelId: ticketChannel.id,
      createdAt: new Date().toISOString(),
      ticketNumber: ticketNum,
    });

    const logCh = guild.channels.cache.get(TICKET_LOG_CHANNEL_ID) as TextChannel | undefined;
    if (logCh) {
      const joinEmbed = new EmbedBuilder()
        .setColor(SUCCESS_COLOR)
        .setTitle("Join Ticket")
        .setDescription(`${channelName} with ID: ${ticketNum} has been opened. Press the button below to join it.`)
        .addFields(
          { name: "Opened By",       value: `<@${user.id}>`,  inline: true },
          { name: "Panel",           value: "Buy Farms",       inline: true },
          { name: "Schematic",       value: schematicType,     inline: true },
          { name: "Due Date",        value: dueDate,           inline: true },
          ...(isCustom && budget ? [{ name: "Budget", value: budget, inline: true }] : []),
          { name: "Staff In Ticket", value: "0",              inline: true },
        )
        
        .setTimestamp();
      await logCh.send({
        embeds: [joinEmbed],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`join_ticket_${ticketChannel.id}`).setLabel("+ Join Ticket").setStyle(ButtonStyle.Primary),
          ),
        ],
      }).catch(() => {});
    }

    await i.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(SUCCESS_COLOR)
          .setTitle("Farm Ticket Created")
          .setDescription(`Your farm ticket has been created: <#${ticketChannel.id}>`)
          .addFields({ name: "Ticket Number", value: ticketTag(ticketNum), inline: true })
          ,
      ],
    });
    return;
  }

  if (customId === "mod_build_price" || customId === "mod_farm_price") {
    if (!i.channel) return;
    const rawInput = customId === "mod_build_price"
      ? i.fields.getTextInputValue("price")
      : i.fields.getTextInputValue("new_price");
    const ticket = storage.getTicket(i.channel.id);
    if (!ticket) { await i.reply({ embeds: [errEmbed("Not a ticket channel.")], flags: 64 }); return; }
    const parsed = parsePriceInput(rawInput);
    const priceStr = parsed !== null ? formatPriceDisplay(parsed, rawInput) : rawInput.trim();
    if (parsed !== null) {
      pendingPriceConfirms.set(i.channel.id, { price: parsed, priceStr, builderId: user.id });
    }
    await i.reply({
      content: `<@${ticket.userId}>`,
      embeds: [
        new EmbedBuilder()
          .setColor(GOLD_COLOR)
          .setTitle("Price Proposal")
          .setDescription(
            `<@${user.id}> has set the price to **${priceStr}**.\n\n` +
            `<@${ticket.userId}>, please confirm or reject this price below.`,
          )
          .setTimestamp(),
      ],
      components: parsed !== null ? [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`build_confirm_price_${i.channel.id}`).setLabel("✅ Confirm Price").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`build_reject_price_${i.channel.id}`).setLabel("❌ Reject Price").setStyle(ButtonStyle.Danger),
        ),
      ] : [],
    });
    return;
  }

  if (customId === "mod_skelly_desc") {
    storage.updateSkellyDescription(i.fields.getTextInputValue("skelly_desc"));
    await i.reply({ embeds: [okEmbed("Skelly description updated.")], flags: 64 }); return;
  }

  if (customId === "mod_skelly_buy" || customId === "mod_skelly_sell") {
    const isBuying = customId === "mod_skelly_buy";
    const { guild } = i;
    if (!guild) return;

    const spawner = i.fields.getTextInputValue("spawner").trim();
    const amount  = i.fields.getTextInputValue("amount").trim();
    const details = i.fields.getTextInputValue("details").trim();

    const existingId = storage.hasOpenTicket(user.id, "skellys", guild.id);
    if (existingId && guild.channels.cache.get(existingId)) {
      await i.reply({
        embeds: [new EmbedBuilder().setColor(WARNING_COLOR).setDescription(`You already have an open skelly ticket: <#${existingId}>`)],
        flags: 64,
      });
      return;
    }
    if (existingId) storage.removeTicket(existingId);

    if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });

    let discordCategory = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === SKELLY_CATEGORY.discordCategoryName,
    ) as CategoryChannel | undefined;
    if (!discordCategory) {
      discordCategory = await guild.channels.create({
        name: SKELLY_CATEGORY.discordCategoryName,
        type: ChannelType.GuildCategory,
        permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
      });
    }

    const ticketNum = storage.nextTicketNumber();
    const safeName  = user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 18) || "user";
    const prefix    = isBuying ? "buy" : "sell";

    const ticketChannel = await guild.channels.create({
      name: `skelly-${prefix}-${safeName}`,
      type: ChannelType.GuildText,
      parent: discordCategory.id,
      topic: `Ticket ${ticketTag(ticketNum)} | ${isBuying ? "Buying" : "Selling"} Spawners | ${user.tag}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: user.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks],
        },
        {
          id: guild.members.me!.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages],
        },
      ],
    });

    const welcomeFields: { name: string; value: string; inline: boolean }[] = [
      { name: "Opened by",                              value: `<@${user.id}>`,                         inline: true  },
      { name: "Ticket",                                 value: ticketTag(ticketNum),                     inline: true  },
      { name: "Type",                                   value: isBuying ? "Buying" : "Selling",          inline: true  },
      { name: "Spawner",                                value: spawner,                                  inline: true  },
      { name: isBuying ? "Amount wanted" : "Amount",   value: amount,                                   inline: true  },
      { name: "Opened",                                 value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
    ];
    if (details) welcomeFields.push({ name: "Details", value: details, inline: false });

    const welcomeEmbed = new EmbedBuilder()
      .setColor(SKELLY_CATEGORY.color)
      .setTitle(`${isBuying ? "Buying" : "Selling"} Spawners: ${ticketTag(ticketNum)}`)
      .setDescription(`${getSkellyPriceText()}\n\nSee <#1518633695404101773> for more info - [click here](${SKELLY_PRICE_CHANNEL})`)
      .addFields(...welcomeFields)
      .setTimestamp();

    const controlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ticket_claim").setLabel("Claim").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ticket_close").setLabel("Close Ticket").setStyle(ButtonStyle.Danger),
    );

    await ticketChannel.send({ content: `<@${user.id}>`, embeds: [welcomeEmbed], components: [controlRow] });

    storage.addTicket(ticketChannel.id, {
      userId: user.id,
      username: user.username,
      categoryId: "skellys",
      guildId: guild.id,
      channelId: ticketChannel.id,
      createdAt: new Date().toISOString(),
      ticketNumber: ticketNum,
    });

    const logCh = guild.channels.cache.get(TICKET_LOG_CHANNEL_ID) as TextChannel | undefined;
    if (logCh) {
      const joinEmbed = new EmbedBuilder()
        .setColor(SKELLY_CATEGORY.color)
        .setTitle(`New Skelly Ticket: ${isBuying ? "Buying" : "Selling"}`)
        .addFields(
          { name: "Opened By", value: `<@${user.id}>`,           inline: true },
          { name: "Spawner",   value: spawner,                    inline: true },
          { name: "Amount",    value: amount,                     inline: true },
          { name: "Ticket",    value: ticketTag(ticketNum),       inline: true },
        )
        .setTimestamp();
      const joinRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`join_ticket_${ticketChannel.id}`).setLabel("+ Join Ticket").setStyle(ButtonStyle.Primary),
      );
      await logCh.send({ embeds: [joinEmbed], components: [joinRow] }).catch(() => {});
    }

    await i.editReply({ embeds: [okEmbed(`✅ Your ticket has been created: <#${ticketChannel.id}>`)] });
    return;
  }

  if (customId === "mod_farm_desc") {
    storage.updateFarmDescription(i.fields.getTextInputValue("farm_desc"));
    await i.reply({ embeds: [okEmbed("Farm description updated.")], flags: 64 }); return;
  }
  if (customId === "mod_farm_list") {
    storage.updateFarmList(i.fields.getTextInputValue("farm_list"));
    await i.reply({ embeds: [okEmbed("Farm list updated.")], flags: 64 }); return;
  }
  if (customId.startsWith("mod_edit_reason_")) {
    const parts = customId.split("_");
    const [, , , guildId, channelId, messageId] = parts;
    const newReason = i.fields.getTextInputValue("new_reason");
    if (!guildId || !channelId || !messageId) {
      await i.reply({ embeds: [errEmbed("Invalid data.")], flags: 64 }); return;
    }
    const guild = i.guild ?? _client?.guilds.cache.get(guildId);
    if (!guild) { await i.reply({ embeds: [errEmbed("Guild not found.")], flags: 64 }); return; }
    const ch = guild.channels.cache.get(channelId) as TextChannel | undefined;
    if (!ch) { await i.reply({ embeds: [errEmbed("Channel not found.")], flags: 64 }); return; }
    const msg = await ch.messages.fetch(messageId).catch(() => null);
    if (!msg) { await i.reply({ embeds: [errEmbed("Message not found.")], flags: 64 }); return; }
    const oldEmbed = msg.embeds[0];
    if (!oldEmbed) { await i.reply({ embeds: [errEmbed("No embed to edit.")], flags: 64 }); return; }
    const updatedEmbed = EmbedBuilder.from(oldEmbed);
    const fields = updatedEmbed.data.fields ?? [];
    const reasonIdx = fields.findIndex((f) => f.name === "❓ Reason");
    if (reasonIdx >= 0) {
      fields[reasonIdx]!.value = newReason;
      updatedEmbed.setFields(fields);
    }
    await msg.edit({ embeds: [updatedEmbed] }).catch(() => {});
    await i.reply({ embeds: [okEmbed(`Reason updated to: **${newReason}**`)], flags: 64 });
    return;
  }

  if (customId === "mod_panel_text") {
    storage.updatePanelText(i.fields.getTextInputValue("panel_title"), i.fields.getTextInputValue("panel_desc"));
    await i.reply({ embeds: [okEmbed("Panel text updated. Resend the panel to apply.")], flags: 64 }); return;
  }
  if (customId.startsWith("mod_cat_")) {
    storage.setCategoryMessage(customId.slice(8), i.fields.getTextInputValue("cat_message"));
    await i.reply({ embeds: [okEmbed("Category message updated.")], flags: 64 }); return;
  }

  if (customId === "mod_sp_add_stock" || customId === "mod_sp_rem_stock") {
    const spGuild = i.guild;
    if (!spGuild) return;
    const isAdd = customId === "mod_sp_add_stock";
    const typeName = i.fields.getTextInputValue("sp_type").trim();
    const amountRaw = parseInt(i.fields.getTextInputValue("sp_amount").trim(), 10);
    if (isNaN(amountRaw) || amountRaw <= 0) {
      await i.reply({ embeds: [errEmbed("Invalid amount. Enter a positive number.")], flags: 64 }); return;
    }
    const delta = isAdd ? amountRaw : -amountRaw;
    const stockResult = storage.updateSpawnerStock(typeName, delta);
    if (!stockResult) {
      await i.reply({ embeds: [errEmbed(`No spawner type matching **${typeName}** found. Use /spawnerpanel and Add Type first.`)], flags: 64 }); return;
    }
    const panelRes = await refreshSpawnerPanel(i.client);
    const panelNote = panelRes.ok ? "\nPanel updated." : `\nPanel not updated: ${panelRes.reason}`;
    const verb = isAdd ? "Added" : "Removed";
    await i.reply({ embeds: [okEmbed(`${verb} **${amountRaw}** to **${stockResult.key} Spawners** stock. New stock: **${stockResult.data.stock}**${panelNote}`)], flags: 64 });
    return;
  }

  if (customId === "mod_sp_set_price") {
    const spGuild = i.guild;
    if (!spGuild) return;
    const typeName = i.fields.getTextInputValue("sp_type").trim();
    const sideRaw = i.fields.getTextInputValue("sp_side").trim().toLowerCase();
    const priceRaw = i.fields.getTextInputValue("sp_price").trim();
    if (sideRaw !== "buy" && sideRaw !== "sell") {
      await i.reply({ embeds: [errEmbed('Side must be "buy" or "sell".')], flags: 64 }); return;
    }
    const side = sideRaw as "buy" | "sell";
    const price = priceRaw.toLowerCase() === "none" ? null : priceRaw;
    const priceResult = storage.setSpawnerPrice(typeName, side, price);
    if (!priceResult) {
      await i.reply({ embeds: [errEmbed(`No spawner type matching **${typeName}** found. Add it first via /spawnerpanel.`)], flags: 64 }); return;
    }
    const panelRes2 = await refreshSpawnerPanel(i.client);
    const panelNote2 = panelRes2.ok ? "\nPanel updated." : `\nPanel not updated: ${panelRes2.reason}`;
    const displayPrice = price === null ? "removed" : `set to **${price}**`;
    await i.reply({ embeds: [okEmbed(`**${priceResult.key} Spawners** ${side} price ${displayPrice}.${panelNote2}`)], flags: 64 });
    return;
  }

  if (customId === "mod_sp_add_type") {
    const spGuild = i.guild;
    if (!spGuild) return;
    const name = i.fields.getTextInputValue("sp_name").trim();
    const added = storage.addSpawnerType(name);
    if (!added) {
      await i.reply({ embeds: [errEmbed(`A spawner type matching **${name}** already exists.`)], flags: 64 }); return;
    }
    await i.reply({ embeds: [okEmbed(`Added **${name} Spawners**. Use /spawnerpanel to set prices.`)], flags: 64 });
    return;
  }

  if (customId === "mod_sp_del_type") {
    const spGuild = i.guild;
    if (!spGuild) return;
    const name = i.fields.getTextInputValue("sp_name").trim();
    const deleted = storage.deleteSpawnerType(name);
    if (!deleted) {
      await i.reply({ embeds: [errEmbed(`No spawner type matching **${name}** found.`)], flags: 64 }); return;
    }
    const panelResDel = await refreshSpawnerPanel(i.client);
    const panelNoteDel = panelResDel.ok ? "\nPanel updated." : `\nPanel not updated: ${panelResDel.reason}`;
    await i.reply({ embeds: [okEmbed(`Removed **${deleted} Spawners**.${panelNoteDel}`)], flags: 64 });
    return;
  }
}

async function handleTicketCreate(
  i: ButtonInteraction | StringSelectMenuInteraction,
  categoryId: string,
  isFarm: boolean,
) {
  const { user, guild } = i;
  if (!guild) return;

  const cat = ALL_CATEGORIES.find((c) => c.id === categoryId);
  if (!cat) return;

  if (!i.deferred && !i.replied) await i.deferReply({ flags: 64 });

  const existingId = storage.hasOpenTicket(user.id, categoryId, guild.id);
  if (existingId && guild.channels.cache.get(existingId)) {
    await i.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(WARNING_COLOR)
          .setDescription(`You already have an open **${cat.label}** ticket: <#${existingId}>`)
          ,
      ],
    });
    return;
  }
  if (existingId) storage.removeTicket(existingId);

  // Verify bot member is cached before attempting channel creation
  const botMemberId = guild.members.me?.id;
  if (!botMemberId) {
    await i.editReply({ embeds: [errEmbed("Internal error: bot member not found. Please try again in a moment.")] });
    return;
  }

  try {
    let discordCategory = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === cat.discordCategoryName,
    ) as CategoryChannel | undefined;

    if (!discordCategory) {
      discordCategory = await guild.channels.create({
        name: cat.discordCategoryName,
        type: ChannelType.GuildCategory,
        permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
      });
    }

  const ticketNum = storage.nextTicketNumber();
  const safeName = user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 18) || "user";
  const channelName = `${cat.channelPrefix}-${safeName}`;

  const overwrites: import("discord.js").OverwriteResolvable[] = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks],
    },
    {
      id: botMemberId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages],
    },
  ];

  const ticketChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: discordCategory.id,
    topic: `Ticket ${ticketTag(ticketNum)} | ${cat.label} | ${user.tag}`,
    permissionOverwrites: overwrites,
  });

  const customMsg = storage.getCategoryMessage(categoryId) ?? cat.description;

  const welcomeEmbed = new EmbedBuilder()
    .setColor(cat.color)
    .setTitle(`${cat.label}: ${ticketTag(ticketNum)}`)
    .setDescription(customMsg)
    .addFields(
      { name: "Opened by", value: `<@${user.id}>`, inline: true },
      { name: "Ticket", value: ticketTag(ticketNum), inline: true },
      { name: "Opened", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
    )
    
    .setTimestamp();

  const controlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ticket_close").setLabel("Close Ticket").setStyle(ButtonStyle.Danger),
  );

  const ping = `<@${user.id}>`;
  await ticketChannel.send({ content: ping, embeds: [welcomeEmbed], components: [controlRow] });

  if (categoryId === "builder-application") {
    const typeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("builder_type_builder").setLabel("Builder").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("builder_type_schematic").setLabel("Schematic Poster").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("builder_type_both").setLabel("Both").setStyle(ButtonStyle.Success),
    );
    await ticketChannel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xe67e22)
          .setTitle("What are you applying for?")
          .setDescription("Please select whether you would like to become a **Builder**, a **Schematic Poster**, or **Both**."),
      ],
      components: [typeRow],
    });
  }

  storage.addTicket(ticketChannel.id, {
    userId: user.id,
    username: user.username,
    categoryId,
    guildId: guild.id,
    channelId: ticketChannel.id,
    createdAt: new Date().toISOString(),
    ticketNumber: ticketNum,
  });

  const logCh = guild.channels.cache.get(TICKET_LOG_CHANNEL_ID) as TextChannel | undefined;
  if (logCh) {
    const joinEmbed = new EmbedBuilder()
      .setColor(isFarm ? SUCCESS_COLOR : 0xed4245)
      .setTitle("Join Ticket")
      .setDescription(`${channelName} with ID: ${ticketNum} has been opened. Press the button below to join it.`)
      .addFields(
        { name: "✅ Opened By",     value: `<@${user.id}>`, inline: true },
        { name: "🔵 Panel",         value: cat.label,       inline: true },
        { name: "👤 Staff In Ticket", value: "0",           inline: true },
      )
      
      .setTimestamp();

    const joinRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`join_ticket_${ticketChannel.id}`)
        .setLabel("+ Join Ticket")
        .setStyle(ButtonStyle.Primary),
    );

    await logCh.send({ embeds: [joinEmbed], components: [joinRow] }).catch(() => {});
  }

  await i.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(cat.color)
        .setTitle("Ticket Created")
        .setDescription(`Your **${cat.label}** ticket has been created: <#${ticketChannel.id}>`)
        .addFields({ name: "Ticket Number", value: ticketTag(ticketNum), inline: true })
        ,
    ],
  });
  } catch (err: unknown) {
    logger.error({ err }, "Ticket creation failed");
    const errMsg = err instanceof Error ? err.message : String(err);
    if (i.deferred || i.replied) {
      await i.editReply({ embeds: [errEmbed(`Failed to create ticket. Please try again or contact an admin. (${errMsg})`)] }).catch(() => {});
    }
  }
}

function backRow(target: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(target).setLabel("Back").setStyle(ButtonStyle.Secondary),
  );
}

function panelEmbed() {
  return new EmbedBuilder()
    .setColor(BOT_COLOR)
    .setTitle("Owner Control Panel")
    .setDescription("Select a section below.")
    .addFields(
      { name: "Server Monitor", value: "Live server statistics", inline: true },
      { name: "Ticket Panel", value: "Manage the ticket system", inline: true },
      { name: "Farm Panel", value: "Manage farm listings", inline: true },
      { name: "Skelly Panel", value: "Manage spawner prices", inline: true },
      { name: "Staff Applications", value: "Send the staff app panel", inline: true },
      { name: "Rules", value: "Send the server rules to this channel", inline: true },
    )
    .setTimestamp();
}

function panelRows() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("panel_server").setLabel("Server Monitor").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("panel_tickets").setLabel("Ticket Panel").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("panel_farms").setLabel("Farm Panel").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("panel_skelly").setLabel("Skelly Panel").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("panel_staff_app").setLabel("Staff Apps").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("panel_rules").setLabel("Send Rules").setStyle(ButtonStyle.Danger),
    ),
  ];
}

function staffAppPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x5b8ef5)
    .setTitle("Applications")
    .setDescription(
      [
        "**Requirements**",
        "• Must be **14+**.",
        "• Must have **10 vouches**.",
        "",
        "**Rules**",
        "• Do not ask about your application after submitting.",
        "• Troll applications can get you blacklisted.",
        "",
        "Choose the application type below.",
      ].join("\n"),
    )
    .setTimestamp();
}

function staffAppPanelComponents() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("staff_apply").setLabel("Staff Application").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function ticketPanelEmbed() {
  const data = storage.getData();
  const embed = new EmbedBuilder()
    .setColor(BOT_COLOR)
    .setTitle(data.ticketPanelTitle)
    
    .setTimestamp();

  const TICKET_PANEL_CATEGORY_IDS = ["support", "giveaway", "skellys"];
  let desc = data.ticketPanelDesc ? data.ticketPanelDesc + "\n\n" : "";
  for (const cat of REGULAR_CATEGORIES.filter((c) => TICKET_PANEL_CATEGORY_IDS.includes(c.id))) {
    const msg = storage.getCategoryMessage(cat.id) ?? cat.description;
    desc += `**${cat.label}** – ${msg}\n\n`;
  }
  desc += `**Partnership** – For server partnership inquiries. Please provide details about your server, player count, and what kind of partnership you are looking for.`;
  embed.setDescription(desc.trim());
  return embed;
}

function ticketPanelComponents() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ticket_btn_support").setLabel("Reports & Support").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ticket_btn_giveaway").setLabel("Giveaway").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ticket_btn_skellys").setLabel("Buy/Sell Skellys").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("partnership_ticket").setLabel("Partnership").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

const SKELLY_PRICE_CHANNEL = "https://discord.com/channels/1450662191890956322/1518633695404101773";

function getSkellyPriceText(): string {
  const spawners = storage.getSpawners();
  const lines: string[] = [];
  lines.push("**Selling:**");
  for (const [name, s] of Object.entries(spawners)) {
    const price = s.sellPrice ?? "—";
    const stock = s.stock ?? 0;
    lines.push(`- ${name} Spawners: ${price} each | Stock: ${stock}`);
  }
  lines.push("", "**Buying:**");
  for (const [name, s] of Object.entries(spawners)) {
    const price = s.buyPrice ?? "—";
    lines.push(`- ${name} Spawners: ${price} each`);
  }
  lines.push("", "**Notes:**", "Our prices are possibly negotiable", "5x5 minimum", "1 spawner minimum");
  return lines.join("\n");
}

async function refreshSpawnerPanel(client: Client): Promise<{ ok: boolean; reason?: string }> {
  const { channelId, messageId } = storage.getSpawnerPanel();
  if (!channelId || !messageId) return { ok: false, reason: "no panel registered" };
  try {
    const ch = await client.channels.fetch(channelId) as TextChannel | null;
    if (!ch) return { ok: false, reason: "channel not found" };
    const msg = await ch.messages.fetch(messageId);
    await msg.edit({ embeds: [skellyTicketPanelEmbed()], components: skellyTicketComponents() });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg };
  }
}

function skellyTicketPanelEmbed() {
  const updatedTs = Math.floor(Date.now() / 1000);
  return new EmbedBuilder()
    .setColor(SKELLY_CATEGORY.color)
    .setTitle("Spawner Prices")
    .setDescription(
      `Last updated: <t:${updatedTs}:R>\n\n${getSkellyPriceText()}\n\nSee <#1518633695404101773> for more details.\nOpen a ticket below to buy or sell.`,
    )
    .setTimestamp();
}

function skellyTicketComponents() {
  const buyBtn  = new ButtonBuilder().setCustomId("skelly_buy").setLabel("Buy Spawners").setStyle(ButtonStyle.Success);
  const sellBtn = new ButtonBuilder().setCustomId("skelly_sell").setLabel("Sell Spawners").setStyle(ButtonStyle.Primary);
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(buyBtn, sellBtn)];
}

function farmTicketPanelEmbed() {
  return new EmbedBuilder()
    .setColor(GOLD_COLOR)
    .setTitle("Building Services")
    .setDescription([
      "**Building Service Rules**",
      "Always pay **`BluqoYT`** and not the builder",
      "If bot fails to track payment send an uncropped screenshot",
      "If the base is raided under 3 days you get a 25% refund",
      "Failure to comply with these rules result in a no refund situation",
      "",
      "Order a build service 👇",
      "",
      "─────────────────────────",
      "**Basalt Farms**",
      "ETZ Basalt Farm 1.1 1 Module - 16.5m/h - **310m**",
      "ETZ Basalt Farm 1.1 4 Module- 66m/h - **1.25b**",
      "",
      "─────────────────────────",
      "**Cobblestone Farms**",
      "16 Module Jouan Farm - 25m/h - **750m**",
      "32 Module Ritz Cobblestone Farm - 50m/h - **1.3b**",
      "64 Module Jouan Farm - 100m/h - **2.6b**",
      "",
      "─────────────────────────",
      "**Bone Block Farms**",
      "Jesterr's Bone Block Crafter V2 - 2,800 Bone Blocks/s - **420m**",
      "",
      "─────────────────────────",
      "**Sweet Berry Farms**",
      "*Coming Soon*",
      "",
      "─────────────────────────",
      "",
      "**Digging Services**",
      "Order a digout service. Price formula: X × Y × Z × $950",
      "",
      "─────────────────────────",
      "",
      "**Partnership**",
      "Interested in buying a build from us? Click the button below.",
      ].join("\n"))
      .setTimestamp();
}

function farmTicketComponents() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("build_service_ticket").setLabel("Building Services").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("dig_service_ticket").setLabel("Digging Services").setStyle(ButtonStyle.Success),
    ),
  ];
}

function farmInfoEmbed() {
  const data = storage.getData();
  return new EmbedBuilder()
    .setColor(GOLD_COLOR)
    .setTitle("Buy Farms")
    .setDescription(data.farmDescription?.trim() || "No description set.")
    .setTimestamp();
}

const STAFF_APP_QUESTIONS = [
  "How old are you?",
  "What makes you different from others?",
  "Do you have any experience being staff?",
  "Please share the server links with us!",
  "How much time can you contribute to the server each day?",
  "Why do you want to be a staff?",
  "What is your Balance, Username and Playtime?",
  "Please include a screenshot of you in f5 holding a piston! (attach the image to your next message)",
  "A player opens a ticket completely enraged, using heavy profanity and insulting the staff team because they were muted for toxicity in the public chat. How do you respond to keep the situation professional?",
  "Do you agree to not ask about your application? (yes/no)",
];

async function runStaffApplication(user: User, guild: Guild) {
  try {
    const dm = await user.createDM();

    const answers: string[] = [];
    const attachmentUrls: (string | null)[] = [];
    const total = STAFF_APP_QUESTIONS.length;

    for (let idx = 0; idx < STAFF_APP_QUESTIONS.length; idx++) {
      const question = STAFF_APP_QUESTIONS[idx]!;
      const num = idx + 1;

      if (idx === 0) {
        await dm.send({
          content:
            `**Staff Application**\n\n` +
            `**Requirements:** You must be 14+, have 25 vouches, and follow the application rules. ` +
            `**Troll applications can blacklist you.**\n\n` +
            `Answer each question one at a time. You have 3 hours to complete this application. ` +
            `If a question asks for a screenshot, send it with that answer.\n` +
            `**Question ${num}/${total}:** ${question}`,
        });
      } else {
        await dm.send({
          content: `**Question ${num}/${total}:** ${question}`,
        });
      }

      let collected;
      try {
        collected = await dm.awaitMessages({
          filter: (m) => m.author.id === user.id,
          max: 1,
          time: 5 * 60 * 1000,
          errors: ["time"],
        });
      } catch {
        await dm.send({
          content: "Application timed out. Please start a new application from the tickets channel.",
        });
        activeStaffApplications.delete(user.id);
        return;
      }

      const msg = collected.first()!;

      if (msg.content.toLowerCase() === "cancel") {
        await dm.send({ content: "Application cancelled. You can restart it anytime from the tickets channel." });
        activeStaffApplications.delete(user.id);
        return;
      }

      answers.push(msg.content.trim() || "(no text provided)");
      attachmentUrls.push(msg.attachments.first()?.url ?? null);
    }

    await dm.send({
      content:
        `**Application Submitted!**\n\n` +
        `Thank you for applying to be a staff member at **Bluqo's Bot**!\n` +
        `Your application has been received and will be reviewed by leadership.\n\n` +
        `**Please do not ask about your application status.** You will be contacted if you move forward.`,
    });

    const client = _client;
    if (!client) return;

    const responsesChannel = client.channels.cache.get(STAFF_APP_RESPONSES_CHANNEL_ID) as TextChannel | undefined
      ?? await client.channels.fetch(STAFF_APP_RESPONSES_CHANNEL_ID).catch(() => null) as TextChannel | null ?? undefined;
    if (!responsesChannel) {
      logger.warn({ channelId: STAFF_APP_RESPONSES_CHANNEL_ID }, "Staff app responses channel not found");
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x5b8ef5)
      .setTitle("New Staff Application")
      .setThumbnail(user.displayAvatarURL())
      .addFields(
        { name: "👤 Applicant", value: `<@${user.id}> (\`${user.tag}\`)`, inline: true },
        { name: "🆔 User ID", value: user.id, inline: true },
        { name: "📅 Submitted", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
      )
      .setTimestamp();

    for (let idx = 0; idx < STAFF_APP_QUESTIONS.length; idx++) {
      const q = STAFF_APP_QUESTIONS[idx]!;
      const a = answers[idx] ?? "(no answer)";
      embed.addFields({
        name: `Q${idx + 1}. ${q.length > 200 ? q.slice(0, 197) + "..." : q}`,
        value: a.length > 1024 ? a.slice(0, 1021) + "..." : a,
      });
    }

    const acceptRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`staff_accept_${user.id}`)
        .setLabel("✅ Accept")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`staff_deny_${user.id}`)
        .setLabel("❌ Deny")
        .setStyle(ButtonStyle.Danger),
    );

    await responsesChannel.send({
      embeds: [embed],
      components: [acceptRow],
    });

    const screenshotUrl = attachmentUrls[7];
    if (screenshotUrl) {
      await responsesChannel.send({
        content: `📸 **Screenshot (Q8) from <@${user.id}>:**\n${screenshotUrl}`,
      }).catch(() => {});
    }
  } catch (err) {
    logger.error({ err }, "Staff application error");
    try {
      const dm = await user.createDM().catch(() => null);
      if (dm) {
        await dm.send({ embeds: [errEmbed("❌ Something went wrong with your application. Please try again later.")] }).catch(() => {});
      }
    } catch {}
  } finally {
    activeStaffApplications.delete(user.id);
  }
}

function okEmbed(msg: string) {
  return new EmbedBuilder().setColor(SUCCESS_COLOR).setDescription(msg);
}
function errEmbed(msg: string) {
  return new EmbedBuilder().setColor(ERROR_COLOR).setDescription(msg);
}
async function sendPermError(msg: Message) {
  await msg.delete().catch(() => {});
  const notice = await (msg.channel as TextChannel).send({
    content: `<@${msg.author.id}>`,
    embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription("You don't have permission to use this command.\n-# Only you can see this message.")],
  }).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), 5000);
}
function infoEmbed(msg: string) {
  return new EmbedBuilder().setColor(BOT_COLOR).setDescription(msg);
}

