// ── Owner ─────────────────────────────────────────────────────────────────────
export const OWNER_IDS: string[] = [
  "1239041489779298358",
  "1491457883219693720",
];
// Primary owner ID (kept for places that need a single value)
export const OWNER_ID = "1491457883219693720";

// ── Roles ─────────────────────────────────────────────────────────────────────
export const OWNER_ROLE_ID      = "1532808512521113814"; // current owner role
export const CO_OWNER_ROLE_ID   = "1532808512521113814"; // current owner role
export const BUILD_TICKET_ROLE_ID    = "1531375209968308274";
export const GIVEAWAY_ROLE_ID        = "1531375074240626790";
export const GENERAL_TICKET_ROLE_ID  = "1531299742364078200";
export const SKELLY_TICKET_ROLE_ID   = "1531374958696071168";
export const MODLOG_STAFF_ROLE_ID    = "1531299742364078200"; // All Staff

// ── Channels ──────────────────────────────────────────────────────────────────
export const TICKET_LOG_CHANNEL_ID        = "1531375622822170735";
export const TRANSCRIPT_CHANNEL_ID        = "1531375761917739019";
export const STAFF_APP_RESPONSES_CHANNEL_ID = "1531152051872989294";
export const SPAM_LOG_CHANNEL_ID          = "1531376198024827020";
export const MOD_LOG_CHANNEL_ID           = "1531376050297376880";
export const INVITE_LOG_CHANNEL_ID        = "1531376692621348894";
export const COUNTING_CHANNEL_ID          = "1531341203990384640";

// Set these once you have the channel IDs:
export const LEVELUP_CHANNEL_ID = "1531103024884219955";

// ── Hardcoded in bot.ts — moved here for easy editing ─────────────────────────
export const WELCOME_CHANNEL_DEFAULT = "1531128842922496160";
export const WELCOME_RULES_CH   = "1531110673483043037";

export const BLACKLISTED_ROLE_ID  = "1531374483481301295";
export const AUTO_JOIN_ROLE_ID    = "1531120075791401152"; // auto-assigned on member join
export const VOUCH_CHANNEL_IDS_LIST = ["1531306783317033162", "1531306818293207040"] as const;
export const VOUCH_CHANNEL_ID_PRIMARY = "1531306783317033162";
export const SKELLY_PRICES_CHANNEL_ID = "1531306497395527910";

// ── Role arrays ───────────────────────────────────────────────────────────────
export const MOD_ROLE_IDS: string[] = [
  "1531158144896729188", // Mod 1 — Helper
  "1531362958020710440", // Mod 2 — Sr.Helper
  "1531122578679271594", // Mod 3 — Moderator
  "1531152631505092608", // Mod 4 — Head Moderator
  "1531169031648972910", // Mod 5 — Co-Owner level
];

export const STAFF_ROLE_IDS: string[] = [
  "1531299742364078200", // Staff
];

// ── Colors ────────────────────────────────────────────────────────────────────
export const BOT_COLOR      = 0x5865f2;
export const SUCCESS_COLOR  = 0x57f287;
export const ERROR_COLOR    = 0xed4245;
export const WARNING_COLOR  = 0xfee75c;
export const GOLD_COLOR     = 0xf1c40f;

// ── Ticket categories ─────────────────────────────────────────────────────────
export interface TicketCategory {
  id: string;
  label: string;
  description: string;
  color: number;
  channelPrefix: string;
  discordCategoryName: string;
  isFarm?: boolean;
}

export const REGULAR_CATEGORIES: TicketCategory[] = [
  {
    id: "support",
    label: "Reports & Support",
    description:
      "For users who need help with server features, commands, roles, bots, or general issues. This ticket should be used when you encounter technical problems or require help from staff members. This also serves to document rule violations together with suspicious activities and harassment incidents and scam attempts and all other types of unacceptable behavior. Please provide clear evidence (screenshots, usernames, timestamps) when possible.",
    color: 0x5865f2,
    channelPrefix: "support",
    discordCategoryName: "Support Tickets",
  },
  {
    id: "giveaway",
    label: "Giveaway",
    description:
      "For giveaway-related questions, issues with entering or claiming prizes, or any concerns about a giveaway. Please include the Giveaway ID if applicable.",
    color: 0xf47bff,
    channelPrefix: "giveaway",
    discordCategoryName: "Giveaway Support Tickets",
  },
  {
    id: "skellys",
    label: "Buy/Sell Skellys",
    description:
      `For purchasing or selling Skelly Spawners. You can view current prices in <#${SKELLY_PRICES_CHANNEL_ID}> before opening a ticket.`,
    color: 0x5865f2,
    channelPrefix: "skelly",
    discordCategoryName: "Skelly Tickets",
  },
  {
    id: "builder-application",
    label: "Builder Application",
    description:
      "Want to become a builder on Bluqo's Bot? Open this ticket and a staff member will review your application. Please be ready to share your builds or portfolio.",
    color: 0xe67e22,
    channelPrefix: "builder-app",
    discordCategoryName: "Support Tickets",
  },
  {
    id: "schematic-application",
    label: "Schematic Application",
    description:
      "Want to become a Schematic Poster on Bluqo's Bot? Open this ticket and a staff member will review your submission. Please be ready to share your schematics.",
    color: 0x9b59b6,
    channelPrefix: "schematic-app",
    discordCategoryName: "Support Tickets",
  },
];

export const SKELLY_CATEGORY: TicketCategory = {
  id: "skellys",
  label: "Buy/Sell Skellys",
  description:
    "For purchase questions, payment issues, donation inquiries, reward claims, buying/selling Skelly Spawners, or anything not covered under Support or Reports.",
  color: 0x5865f2,
  channelPrefix: "skelly",
  discordCategoryName: "Skelly Tickets",
};

export const FARM_CATEGORY: TicketCategory = {
  id: "buy-farms",
  label: "Buy Farms",
  description:
    "Buy Farms – For users interested in purchasing a farm. Use this ticket for farm availability, pricing, purchase inquiries, or any questions related to buying a farm.",
  color: SUCCESS_COLOR,
  channelPrefix: "build",
  discordCategoryName: "Build Tickets",
  isFarm: true,
};

export const BUILDER_CATEGORY: TicketCategory = REGULAR_CATEGORIES.find((c) => c.id === "builder-application")!;

export const ALL_CATEGORIES: TicketCategory[] = [...REGULAR_CATEGORIES, SKELLY_CATEGORY, FARM_CATEGORY];

export const PAYMENT_PARTNER_IGN = "brqydn";
export const PAYMENT_PARTNER_CUT = 0.15;
