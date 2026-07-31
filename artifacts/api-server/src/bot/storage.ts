import fs from "fs";
import path from "path";
import pg from "pg";

const { Pool } = pg;

// ── PostgreSQL backup pool ───────────────────────────────────────────────────
let _dbPool: InstanceType<typeof Pool> | null = null;
let _dbPoolReady = false;
let _syncEnabled = false;

async function ensureDBPool(): Promise<InstanceType<typeof Pool> | null> {
  if (_dbPoolReady) return _dbPool;
  _dbPoolReady = true;
  if (!process.env["DATABASE_URL"]) return null;
  try {
    _dbPool = new Pool({ connectionString: process.env["DATABASE_URL"] });
    await _dbPool.query(`
      CREATE TABLE IF NOT EXISTS bot_data_backup (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    return _dbPool;
  } catch (err) {
    console.error("[storage] Failed to init DB pool:", err);
    _dbPool = null;
    return null;
  }
}

function syncToDB(data: BotData): void {
  if (!_syncEnabled) return;
  void (async () => {
    const pool = await ensureDBPool();
    if (!pool) return;
    try {
      await pool.query(
        `INSERT INTO bot_data_backup (id, data, updated_at)
         VALUES ('main', $1, NOW())
         ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
        [JSON.stringify(data)],
      );
    } catch (err) {
      console.error("[storage] DB sync error:", err);
    }
  })();
}

export async function initStorageFromDB(): Promise<void> {
  const pool = await ensureDBPool();
  if (!pool) {
    _syncEnabled = true;
    return;
  }
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const result = await pool.query<{ data: Partial<BotData> }>(
        "SELECT data FROM bot_data_backup WHERE id = 'main'",
      );
      if (result.rows.length > 0 && result.rows[0]?.data) {
        _data = { ...defaultData(), ...(result.rows[0].data as Partial<BotData>) };
        saveData(_data);
        console.log("[storage] Restored bot data from PostgreSQL backup.");
      }
    }
  } catch (err) {
    console.error("[storage] Failed to restore from DB:", err);
  }
  _syncEnabled = true;
}

export interface TicketEntry {
  userId: string;
  username: string;
  categoryId: string;
  guildId: string;
  channelId: string;
  createdAt: string;
  ticketNumber: number;
  claimedBy?: string;
  claimedById?: string;
  joinedStaff?: string[];
  giveawayId?: string; // set for giveaway-claim tickets
}

export interface StaffTaskEntry {
  ticketsRenamed: number;
  ticketsHandled: number;   // non-build tickets closed (support, skelly, giveaway, etc.)
  buildsCompleted: number;  // build/farm tickets closed
  sponsoredAmount: number;  // total giveaway prize value paid out (tracked per giveaway host)
  messagesSent: number;
}

export interface WarnEntry {
  userId: string;
  reason: string;
  moderatorId: string;
  moderatorTag: string;
  timestamp: string;
}

export interface StickerEntry {
  channelId: string;
  guildId: string;
  messageId: string;
  text: string;
  createdAt: string;
}

export interface GiveawayEntry {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string;
  hostId: string;
  prize: string;
  description: string;
  winnersCount: number;
  endTime: string;
  entries: string[];
  ended: boolean;
  winners: string[];
  claimedBy: string[];
  claimExpiry: string | null;
  winMessages: Record<string, string>;
  type: "normal" | "simple" | "double" | "quickdrop";
}

export interface XpEntry {
  xp: number;
  lastMessage: number;
}

export interface ViolationEntry {
  count: number;
  expiresAt: string; // ISO timestamp — when this counter resets
}

export interface SpawnerData {
  buyPrice: string | null;
  sellPrice: string | null;
  stock: number;
}

export interface ReactionRoleEntry {
  messageId: string;
  channelId: string;
  guildId: string;
  emoji: string;
  roleId: string;
}

export interface AutomodConfig {
  customBadWords: string[];
  allowedLinkDomains: string[];
  spamThreshold: number;
  spamWindowMs: number;
}

export interface ViolationLogEntry {
  type: string;
  reason: string;
  snippet: string;
  timestamp: string;
}

interface BotData {
  tickets: Record<string, TicketEntry>;
  ticketCounter: number;
  farmDescription: string;
  farmList: string;
  skellyDescription: string;
  categoryMessages: Record<string, string>;
  ticketPanelTitle: string;
  ticketPanelDesc: string;
  giveaways: Record<string, GiveawayEntry>;
  stickers: Record<string, StickerEntry>;
  warns: Record<string, WarnEntry[]>;
  welcomeChannelId: string;
  xp: Record<string, XpEntry>;
  violations: Record<string, ViolationEntry>;
  spawners: Record<string, SpawnerData>;
  spawnerPanelChannelId: string;
  spawnerPanelMessageId: string;
  appBlacklist: Record<string, { reason: string; by: string; at: string }>;
  reactionRoles: Record<string, ReactionRoleEntry>;
  automod: AutomodConfig;
  violationLog: Record<string, ViolationLogEntry[]>;
  invites: {
    byInviter: Record<string, { joins: number; leaves: number }>;
    byInvitee: Record<string, string>; // inviteeId → inviterId
  };
  counting: {
    current: number;    // next expected number (starts at 1)
    lastUserId: string; // user who sent the last correct number
  };
  staffTasks: Record<string, StaffTaskEntry>;
}

// Store data OUTSIDE the workspace so it is never overwritten by deployments or git.
const DATA_DIR = "/home/runner/bot-data";
const DATA_FILE = path.join(DATA_DIR, "bot-data.json");
const TRANSCRIPT_DIR = path.join(DATA_DIR, "bot-transcripts");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TRANSCRIPT_DIR)) fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });

function defaultData(): BotData {
  return {
    tickets: {},
    ticketCounter: 0,
    xp: {},
    violations: {},
    farmDescription:
      "Buy Farms – For users interested in purchasing a farm. Use this ticket for farm availability, pricing, purchase inquiries, or any questions related to buying a farm.",
    farmList: "",
    skellyDescription:
      "Buy/Sell Skellys – For purchase questions, payment issues, donation inquiries, reward claims, or buying/selling Skelly Spawners.",
    categoryMessages: {},
    ticketPanelTitle: "Support Tickets",
    ticketPanelDesc:
      "Need help or have a question? Click one of the buttons below to open a ticket. Our staff will assist you as soon as possible.",
    giveaways: {},
    stickers: {},
    warns: {},
    welcomeChannelId: "",
    spawnerPanelChannelId: "",
    spawnerPanelMessageId: "",
    appBlacklist: {},
    reactionRoles: {},
    automod: {
      customBadWords: [],
      allowedLinkDomains: [],
      spamThreshold: 5,
      spamWindowMs: 8_000,
    },
    violationLog: {},
    invites: { byInviter: {}, byInvitee: {} },
    counting: { current: 1, lastUserId: "" },
    staffTasks: {},
    spawners: {
      "Skeleton":   { buyPrice: "4.1m", sellPrice: "5m",  stock: 0 },
      "Creeper":    { buyPrice: "5m",   sellPrice: "8m",  stock: 0 },
      "Iron Golem": { buyPrice: "6m",   sellPrice: "10m", stock: 0 },
    },
  };
}

function loadData(): BotData {
  if (!fs.existsSync(DATA_FILE)) return defaultData();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<BotData>;
    const defaults = defaultData();
    const merged = { ...defaults, ...parsed };
    merged.spawners = { ...defaults.spawners, ...parsed.spawners };
    return merged;
  } catch (err) {
    console.error("[storage] Failed to parse bot-data.json - attempting backup restore:", err);
    const backup = DATA_FILE + ".bak";
    if (fs.existsSync(backup)) {
      try {
        const raw = fs.readFileSync(backup, "utf8");
        const parsed = JSON.parse(raw) as Partial<BotData>;
        console.error("[storage] Restored from backup successfully.");
        const defaults = defaultData();
        const merged = { ...defaults, ...parsed };
        merged.spawners = { ...defaults.spawners, ...parsed.spawners };
        return merged;
      } catch {
        console.error("[storage] Backup also unreadable - starting with empty data.");
      }
    }
    return defaultData();
  }
}

function saveData(data: BotData): void {
  const json = JSON.stringify(data, null, 2);
  const tmp = DATA_FILE + ".tmp";
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(tmp, json, "utf8");
    fs.renameSync(tmp, DATA_FILE);
    // Keep a backup copy one write behind for safety
    try { fs.copyFileSync(DATA_FILE, DATA_FILE + ".bak"); } catch {}
  } catch (err) {
    console.error("[storage] Failed to save data:", err);
    // Fallback: write directly without atomic rename
    try { fs.writeFileSync(DATA_FILE, json, "utf8"); } catch {}
  }
  syncToDB(data);
}

let _data = loadData();

export const storage = {
  getData: () => _data,

  nextTicketNumber(): number {
    _data.ticketCounter = (_data.ticketCounter ?? 0) + 1;
    saveData(_data);
    return _data.ticketCounter;
  },

  addTicket(channelId: string, ticket: TicketEntry) {
    _data.tickets[channelId] = ticket;
    saveData(_data);
  },

  removeTicket(channelId: string) {
    delete _data.tickets[channelId];
    saveData(_data);
  },

  claimTicket(channelId: string, username: string, userId: string) {
    if (_data.tickets[channelId]) {
      _data.tickets[channelId]!.claimedBy = username;
      _data.tickets[channelId]!.claimedById = userId;
      saveData(_data);
    }
  },

  joinTicket(channelId: string, userId: string): boolean {
    const ticket = _data.tickets[channelId];
    if (!ticket) return false;
    if (!ticket.joinedStaff) ticket.joinedStaff = [];
    if (ticket.joinedStaff.includes(userId)) return false;
    ticket.joinedStaff.push(userId);
    saveData(_data);
    return true;
  },

  getTicket(channelId: string): TicketEntry | undefined {
    return _data.tickets[channelId];
  },

  saveTranscript(ticketNumber: number, content: string): string {
    const file = path.join(TRANSCRIPT_DIR, `ticket-${String(ticketNumber).padStart(4, "0")}.txt`);
    fs.writeFileSync(file, content, "utf8");
    return file;
  },

  readTranscript(ticketNumber: number): Buffer | null {
    const file = path.join(TRANSCRIPT_DIR, `ticket-${String(ticketNumber).padStart(4, "0")}.txt`);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file);
  },

  getTicketsByGuild(guildId: string): (TicketEntry & { channelId: string })[] {
    return Object.entries(_data.tickets)
      .filter(([, t]) => t.guildId === guildId)
      .map(([channelId, t]) => ({ ...t, channelId }));
  },

  hasOpenTicket(userId: string, categoryId: string, guildId: string): string | null {
    const entry = Object.entries(_data.tickets).find(
      ([, t]) => t.userId === userId && t.categoryId === categoryId && t.guildId === guildId,
    );
    return entry ? entry[0] : null;
  },

  updateSkellyDescription(desc: string) {
    _data.skellyDescription = desc ?? "";
    saveData(_data);
  },

  updateFarmDescription(desc: string) {
    _data.farmDescription = desc;
    saveData(_data);
  },

  updateFarmList(list: string) {
    _data.farmList = list;
    saveData(_data);
  },

  setCategoryMessage(categoryId: string, message: string) {
    _data.categoryMessages[categoryId] = message;
    saveData(_data);
  },

  getCategoryMessage(categoryId: string): string | undefined {
    return _data.categoryMessages[categoryId];
  },

  updatePanelText(title: string, desc: string) {
    _data.ticketPanelTitle = title;
    _data.ticketPanelDesc = desc;
    saveData(_data);
  },

  addGiveaway(giveaway: GiveawayEntry) {
    if (!_data.giveaways) _data.giveaways = {};
    _data.giveaways[giveaway.id] = giveaway;
    saveData(_data);
  },

  getGiveaway(id: string): GiveawayEntry | undefined {
    return _data.giveaways?.[id];
  },

  getActiveGiveaways(): GiveawayEntry[] {
    if (!_data.giveaways) return [];
    return Object.values(_data.giveaways).filter((g) => !g.ended);
  },

  enterGiveaway(id: string, userId: string): boolean {
    const gw = _data.giveaways?.[id];
    if (!gw || gw.ended) return false;
    if (gw.entries.includes(userId)) return false;
    gw.entries.push(userId);
    saveData(_data);
    return true;
  },

  leaveGiveaway(id: string, userId: string): boolean {
    const gw = _data.giveaways?.[id];
    if (!gw || gw.ended) return false;
    const idx = gw.entries.indexOf(userId);
    if (idx === -1) return false;
    gw.entries.splice(idx, 1);
    saveData(_data);
    return true;
  },

  endGiveaway(id: string, winners: string[]) {
    const gw = _data.giveaways?.[id];
    if (!gw) return;
    gw.ended = true;
    gw.winners = winners;
    saveData(_data);
  },

  setClaimExpiry(id: string, expiry: string) {
    const gw = _data.giveaways?.[id];
    if (!gw) return;
    gw.claimExpiry = expiry;
    saveData(_data);
  },

  addWinMessage(id: string, winnerId: string, messageId: string) {
    const gw = _data.giveaways?.[id];
    if (!gw) return;
    if (!gw.winMessages) gw.winMessages = {};
    gw.winMessages[winnerId] = messageId;
    saveData(_data);
  },

  claimGiveaway(id: string, userId: string): boolean {
    const gw = _data.giveaways?.[id];
    if (!gw) return false;
    if (!gw.winners.includes(userId)) return false;
    if (gw.claimedBy.includes(userId)) return false;
    if (gw.claimExpiry && new Date() > new Date(gw.claimExpiry)) return false;
    gw.claimedBy.push(userId);
    saveData(_data);
    return true;
  },

  updateGiveawayMessage(id: string, messageId: string) {
    const gw = _data.giveaways?.[id];
    if (!gw) return;
    gw.messageId = messageId;
    saveData(_data);
  },

  addSticker(sticker: StickerEntry) {
    if (!_data.stickers) _data.stickers = {};
    _data.stickers[sticker.messageId] = sticker;
    saveData(_data);
  },

  getSticker(messageId: string): StickerEntry | undefined {
    return _data.stickers?.[messageId];
  },

  getStickersForChannel(channelId: string): StickerEntry[] {
    if (!_data.stickers) return [];
    return Object.values(_data.stickers).filter((s) => s.channelId === channelId);
  },

  replaceStickerMessage(oldMessageId: string, newMessageId: string): boolean {
    const s = _data.stickers?.[oldMessageId];
    if (!s) return false;
    delete _data.stickers[oldMessageId];
    s.messageId = newMessageId;
    _data.stickers[newMessageId] = s;
    saveData(_data);
    return true;
  },

  // Like replaceStickerMessage but falls back to channelId+text lookup when the
  // old message-ID key is stale (e.g. bot restarted mid-repost). Guarantees the
  // new ID is always persisted so duplicates can't accumulate.
  repostStickerMessage(channelId: string, text: string, oldMessageId: string, newMessageId: string): void {
    if (!_data.stickers) _data.stickers = {};
    // Primary: find by the key we expect
    let entry = Object.entries(_data.stickers).find(([k]) => k === oldMessageId);
    // Fallback: the key is stale — find by channel + text
    if (!entry) {
      entry = Object.entries(_data.stickers).find(
        ([, s]) => s.channelId === channelId && s.text === text,
      );
    }
    if (entry) {
      const [oldKey, s] = entry;
      delete _data.stickers[oldKey];
      s.messageId = newMessageId;
      _data.stickers[newMessageId] = s;
    } else {
      // Nothing found at all — create a fresh entry so we don't lose track
      _data.stickers[newMessageId] = { channelId, guildId: "", messageId: newMessageId, text, createdAt: new Date().toISOString() };
    }
    saveData(_data);
  },

  updateStickerText(messageId: string, text: string): boolean {
    const s = _data.stickers?.[messageId];
    if (!s) return false;
    s.text = text;
    saveData(_data);
    return true;
  },

  deleteSticker(messageId: string): StickerEntry | undefined {
    const s = _data.stickers?.[messageId];
    if (!s) return undefined;
    delete _data.stickers[messageId];
    saveData(_data);
    return s;
  },

  addWarn(userId: string, warn: WarnEntry): number {
    if (!_data.warns) _data.warns = {};
    if (!_data.warns[userId]) _data.warns[userId] = [];
    _data.warns[userId]!.push(warn);
    saveData(_data);
    return _data.warns[userId]!.length;
  },

  getWarns(userId: string): WarnEntry[] {
    return _data.warns?.[userId] ?? [];
  },

  clearWarns(userId: string): void {
    if (_data.warns) delete _data.warns[userId];
    saveData(_data);
  },

  removeWarn(userId: string, idx: number): boolean {
    const warns = _data.warns?.[userId];
    if (!warns || idx < 0 || idx >= warns.length) return false;
    warns.splice(idx, 1);
    saveData(_data);
    return true;
  },

  setWelcomeChannelId(id: string): void {
    _data.welcomeChannelId = id;
    saveData(_data);
  },

  getWelcomeChannelId(): string {
    return _data.welcomeChannelId ?? "";
  },

  getXP(userId: string): XpEntry {
    if (!_data.xp) _data.xp = {};
    return _data.xp[userId] ?? { xp: 0, lastMessage: 0 };
  },

  addXP(userId: string, amount: number): void {
    if (!_data.xp) _data.xp = {};
    const entry = _data.xp[userId] ?? { xp: 0, lastMessage: 0 };
    entry.xp += amount;
    entry.lastMessage = Date.now();
    _data.xp[userId] = entry;
    saveData(_data);
  },

  // Add XP without touching lastMessage — used for voice XP so text cooldown is unaffected
  addXPOnly(userId: string, amount: number): void {
    if (!_data.xp) _data.xp = {};
    const entry = _data.xp[userId] ?? { xp: 0, lastMessage: 0 };
    entry.xp += amount;
    _data.xp[userId] = entry;
    saveData(_data);
  },

  setXpCooldown(userId: string): void {
    if (!_data.xp) _data.xp = {};
    const entry = _data.xp[userId] ?? { xp: 0, lastMessage: 0 };
    entry.lastMessage = Date.now();
    _data.xp[userId] = entry;
    saveData(_data);
  },

  getAllXP(): Record<string, XpEntry> {
    return _data.xp ?? {};
  },

  resetAllXP(): void {
    _data.xp = {};
    saveData(_data);
  },

  // ── Violations (progressive punishment, permanent — violations never expire) ──
  getViolationCount(userId: string): number {
    if (!_data.violations) _data.violations = {};
    const v = _data.violations[userId];
    if (!v) return 0;
    return v.count;
  },

  incrementViolation(userId: string, _windowMs: number): number {
    if (!_data.violations) _data.violations = {};
    const v = _data.violations[userId];
    if (!v) {
      _data.violations[userId] = { count: 1, expiresAt: "9999-12-31T00:00:00.000Z" };
    } else {
      v.count += 1;
    }
    saveData(_data);
    return _data.violations[userId]!.count;
  },

  clearViolation(userId: string): void {
    if (!_data.violations) return;
    delete _data.violations[userId];
    saveData(_data);
  },

  // ── AutoMod config (custom bad words, allowed link domains, spam thresholds) ──
  getAutomodConfig(): AutomodConfig {
    if (!_data.automod) {
      _data.automod = { customBadWords: [], allowedLinkDomains: [], spamThreshold: 5, spamWindowMs: 8_000 };
    }
    return _data.automod;
  },

  addBadWord(word: string): boolean {
    const cfg = this.getAutomodConfig();
    const w = word.trim().toLowerCase();
    if (!w || cfg.customBadWords.includes(w)) return false;
    cfg.customBadWords.push(w);
    saveData(_data);
    return true;
  },

  removeBadWord(word: string): boolean {
    const cfg = this.getAutomodConfig();
    const w = word.trim().toLowerCase();
    const idx = cfg.customBadWords.indexOf(w);
    if (idx === -1) return false;
    cfg.customBadWords.splice(idx, 1);
    saveData(_data);
    return true;
  },

  addAllowedDomain(domain: string): boolean {
    const cfg = this.getAutomodConfig();
    const d = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!d || cfg.allowedLinkDomains.includes(d)) return false;
    cfg.allowedLinkDomains.push(d);
    saveData(_data);
    return true;
  },

  removeAllowedDomain(domain: string): boolean {
    const cfg = this.getAutomodConfig();
    const d = domain.trim().toLowerCase();
    const idx = cfg.allowedLinkDomains.indexOf(d);
    if (idx === -1) return false;
    cfg.allowedLinkDomains.splice(idx, 1);
    saveData(_data);
    return true;
  },

  setSpamThreshold(threshold: number): void {
    const cfg = this.getAutomodConfig();
    cfg.spamThreshold = threshold;
    saveData(_data);
  },

  setSpamWindowMs(windowMs: number): void {
    const cfg = this.getAutomodConfig();
    cfg.spamWindowMs = windowMs;
    saveData(_data);
  },

  // ── Violation log (per-user history of automod violations) ──
  addViolationLogEntry(userId: string, entry: ViolationLogEntry): void {
    if (!_data.violationLog) _data.violationLog = {};
    const list = _data.violationLog[userId] ?? [];
    list.push(entry);
    if (list.length > 100) list.shift();
    _data.violationLog[userId] = list;
    saveData(_data);
  },

  getViolationLogEntries(userId: string): ViolationLogEntry[] {
    return _data.violationLog?.[userId] ?? [];
  },

  getSpawners(): Record<string, SpawnerData> {
    if (!_data.spawners) _data.spawners = defaultData().spawners;
    return _data.spawners;
  },

  updateSpawnerStock(name: string, delta: number): { key: string; data: SpawnerData } | null {
    if (!_data.spawners) _data.spawners = defaultData().spawners;
    const key = Object.keys(_data.spawners).find((k) => k.toLowerCase() === name.toLowerCase());
    if (!key) return null;
    _data.spawners[key].stock = Math.max(0, (_data.spawners[key].stock ?? 0) + delta);
    saveData(_data);
    return { key, data: _data.spawners[key] };
  },

  setSpawnerPrice(name: string, type: "buy" | "sell", price: string | null): { key: string; data: SpawnerData } | null {
    if (!_data.spawners) _data.spawners = defaultData().spawners;
    const key = Object.keys(_data.spawners).find((k) => k.toLowerCase() === name.toLowerCase());
    if (!key) return null;
    if (type === "buy") _data.spawners[key].buyPrice = price;
    else _data.spawners[key].sellPrice = price;
    saveData(_data);
    return { key, data: _data.spawners[key] };
  },

  addSpawnerType(name: string): boolean {
    if (!_data.spawners) _data.spawners = defaultData().spawners;
    const exists = Object.keys(_data.spawners).some((k) => k.toLowerCase() === name.toLowerCase());
    if (exists) return false;
    const properName = name.charAt(0).toUpperCase() + name.slice(1);
    _data.spawners[properName] = { buyPrice: null, sellPrice: null, stock: 0 };
    saveData(_data);
    return true;
  },

  deleteSpawnerType(name: string): string | null {
    if (!_data.spawners) return null;
    const key = Object.keys(_data.spawners).find((k) => k.toLowerCase() === name.toLowerCase());
    if (!key) return null;
    delete _data.spawners[key];
    saveData(_data);
    return key;
  },

  addAppBlacklist(userId: string, reason: string, by: string): void {
    if (!_data.appBlacklist) _data.appBlacklist = {};
    _data.appBlacklist[userId] = { reason, by, at: new Date().toISOString() };
    saveData(_data);
  },

  removeAppBlacklist(userId: string): boolean {
    if (!_data.appBlacklist?.[userId]) return false;
    delete _data.appBlacklist[userId];
    saveData(_data);
    return true;
  },

  getAppBlacklist(userId: string): { reason: string; by: string; at: string } | null {
    return _data.appBlacklist?.[userId] ?? null;
  },

  getAllAppBlacklisted(): Record<string, { reason: string; by: string; at: string }> {
    return _data.appBlacklist ?? {};
  },

  setSpawnerPanel(channelId: string, messageId: string): void {
    _data.spawnerPanelChannelId = channelId;
    _data.spawnerPanelMessageId = messageId;
    saveData(_data);
  },

  getSpawnerPanel(): { channelId: string; messageId: string } {
    return {
      channelId: _data.spawnerPanelChannelId ?? "",
      messageId: _data.spawnerPanelMessageId ?? "",
    };
  },

  addReactionRole(entry: ReactionRoleEntry): void {
    if (!_data.reactionRoles) _data.reactionRoles = {};
    const key = `${entry.messageId}:${entry.emoji}`;
    _data.reactionRoles[key] = entry;
    saveData(_data);
  },

  removeReactionRole(messageId: string, emoji: string): boolean {
    if (!_data.reactionRoles) return false;
    const key = `${messageId}:${emoji}`;
    if (!_data.reactionRoles[key]) return false;
    delete _data.reactionRoles[key];
    saveData(_data);
    return true;
  },

  getReactionRole(messageId: string, emoji: string): ReactionRoleEntry | null {
    return _data.reactionRoles?.[`${messageId}:${emoji}`] ?? null;
  },

  getReactionRolesForMessage(messageId: string): ReactionRoleEntry[] {
    if (!_data.reactionRoles) return [];
    return Object.values(_data.reactionRoles).filter((r) => r.messageId === messageId);
  },

  getAllReactionRoles(): ReactionRoleEntry[] {
    return Object.values(_data.reactionRoles ?? {});
  },

  // ── Invite tracker ───────────────────────────────────────────────────────
  recordInviteJoin(inviteeId: string, inviterId: string): { joins: number; leaves: number } {
    if (!_data.invites) _data.invites = { byInviter: {}, byInvitee: {} };
    _data.invites.byInvitee[inviteeId] = inviterId;
    const stats = _data.invites.byInviter[inviterId] ?? { joins: 0, leaves: 0 };
    stats.joins += 1;
    _data.invites.byInviter[inviterId] = stats;
    saveData(_data);
    return stats;
  },

  recordInviteLeave(inviteeId: string): { inviterId: string; valid: number } | null {
    if (!_data.invites) return null;
    const inviterId = _data.invites.byInvitee[inviteeId];
    if (!inviterId) return null;
    const stats = _data.invites.byInviter[inviterId] ?? { joins: 0, leaves: 0 };
    stats.leaves = Math.min(stats.leaves + 1, stats.joins);
    _data.invites.byInviter[inviterId] = stats;
    delete _data.invites.byInvitee[inviteeId];
    saveData(_data);
    return { inviterId, valid: stats.joins - stats.leaves };
  },

  getInviterValid(inviterId: string): number {
    const stats = _data.invites?.byInviter[inviterId];
    if (!stats) return 0;
    return Math.max(0, stats.joins - stats.leaves);
  },

  // ── Counting channel ─────────────────────────────────────────────────────
  getCountingState(): { current: number; lastUserId: string } {
    return _data.counting ?? { current: 1, lastUserId: "" };
  },

  setCountingState(current: number, lastUserId: string): void {
    if (!_data.counting) _data.counting = { current: 1, lastUserId: "" };
    _data.counting.current = current;
    _data.counting.lastUserId = lastUserId;
    saveData(_data);
  },

  // ── Staff tasks (performance ledger) ─────────────────────────────────────
  getStaffTask(userId: string): StaffTaskEntry {
    if (!_data.staffTasks) _data.staffTasks = {};
    return _data.staffTasks[userId] ?? {
      ticketsRenamed: 0,
      ticketsHandled: 0,
      buildsCompleted: 0,
      sponsoredAmount: 0,
      messagesSent: 0,
    };
  },

  getAllStaffTasks(): Record<string, StaffTaskEntry> {
    return _data.staffTasks ?? {};
  },

  incrementStaffRename(userId: string): void {
    if (!_data.staffTasks) _data.staffTasks = {};
    const e = this.getStaffTask(userId);
    e.ticketsRenamed++;
    _data.staffTasks[userId] = e;
    saveData(_data);
  },

  incrementStaffHandled(userId: string): void {
    if (!_data.staffTasks) _data.staffTasks = {};
    const e = this.getStaffTask(userId);
    e.ticketsHandled++;
    _data.staffTasks[userId] = e;
    saveData(_data);
  },

  incrementBuildsCompleted(userId: string): void {
    if (!_data.staffTasks) _data.staffTasks = {};
    const e = this.getStaffTask(userId);
    e.buildsCompleted++;
    _data.staffTasks[userId] = e;
    saveData(_data);
  },

  addSponsoredAmount(userId: string, amount: number): void {
    if (!_data.staffTasks) _data.staffTasks = {};
    const e = this.getStaffTask(userId);
    e.sponsoredAmount += amount;
    _data.staffTasks[userId] = e;
    saveData(_data);
  },

  incrementMessages(userId: string): void {
    if (!_data.staffTasks) _data.staffTasks = {};
    const e = this.getStaffTask(userId);
    e.messagesSent++;
    _data.staffTasks[userId] = e;
    saveData(_data);
  },
};
