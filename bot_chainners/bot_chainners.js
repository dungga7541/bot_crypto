import { chromium } from "playwright";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Cookies + localStorage; avoids Chrome `user_data` profile locks / "profile" corruption. */
const STORAGE_STATE_PATH = path.join(__dirname, "playwright_state.json");

// ================= AI LOGGING =================
const LOGS_DIR = path.join(__dirname, "logs");
const AI_LOG_FILE = path.join(LOGS_DIR, "ai_farm.log");
const PERF_LOG_FILE = path.join(LOGS_DIR, "performance.log");

function ensureLogsDir() {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
}
ensureLogsDir();

function aiLog(type, data) {
    const entry = { ts: new Date().toISOString(), type, data };
    try { fs.appendFileSync(AI_LOG_FILE, JSON.stringify(entry) + "\n"); } catch { }
}

function perfLog(operation, durationMs, success, extra = {}) {
    const entry = { ts: new Date().toISOString(), op: operation, ms: durationMs, ok: success, ...extra };
    try { fs.appendFileSync(PERF_LOG_FILE, JSON.stringify(entry) + "\n"); } catch { }
}

// ================= TIMING CONFIG =================
const TIMING = {
    gardenMinInterval: 5000,
    inventoryMinInterval: 8000,
    harvestCheckInterval: 5000,
    minHarvestGap: 2000,
    postHarvestWait: [1500, 2500],
    postPlantWait: [1500, 3000],
    cycleEndWait: [3000, 6000],
    retryBackoff: [5000, 10000],
    rateLimitBackoff: [15000, 30000],
    cloudflareTimeout: 60000,
    harvestClickTimeout: 15000,
    apiTimeout: 30000, // Increased from 15s to 30s for slow responses
    maxAiLogSize: 5 * 1024 * 1024,
};

let recentSuccessRate = 1.0;
function adaptiveWait(baseRange) {
    const [min, max] = baseRange;
    const factor = 1 + (1 - recentSuccessRate) * 0.5;
    return rand(Math.floor(min * factor), Math.floor(max * factor));
}
function updateSuccessRate(success) {
    recentSuccessRate = recentSuccessRate * 0.8 + (success ? 1 : 0) * 0.2;
}

async function saveStorageState(context) {
    try {
        await context.storageState({ path: STORAGE_STATE_PATH });
    } catch {
        /* context closed */
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min) + min);
const HAS_TTY_STDIN = Boolean(process.stdin.isTTY);

let canHarvest = false;
let userFarmingID = null;
let candidateFarmingIDs = [];
let emptyBedsCache = [];
let bedToGardenMap = {};
let lastGardensData = null;
let lastHarvestAttemptAt = 0;
let lastFarmLogKey = "";
let lastInventoryFetchAt = 0;
let lastGardenFetchAt = 0;
let skipNextCycle = false;
let hasSkipInputListener = false;

// ================= METRICS =================
let metrics = {
    harvestsTotal: 0, harvestsApi: 0, harvestsPage: 0, harvestsUi: 0,
    plantsTotal: 0, plantsApi: 0, plantsUi: 0,
    cyclesCompleted: 0, cyclesSkipped: 0, errors: 0, rateLimitsHit: 0,
    startTime: Date.now()
};
function logMetrics() {
    const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
    aiLog("metrics", { ...metrics, uptime });
    return { ...metrics, uptime };
}

/** @type {{ itemID: string, itemCode: string, count: number }[]} */
let cachedFarmSeeds = [];

/** @type {{ itemID: string, itemCode: string, count: number }[]} */
let cachedVegetables = [];

/** @type {string} */
let lastRewardPoolBlockId =
    process.env.CHAINERS_REWARD_POOL_BLOCK_ID ||
    process.env.CHAINERS_REWARDS_POOLS_BLOCKS_ID ||
    "";

/** @type {Record<string, string>} */
let lastChainersApiHeaders = {};

const FARM_INVENTORY_URL =
    "https://chainers.io/api/farm/user/inventory?sort=lastUpdated&itemType=all&sortDirection=-1&skip=0&limit=0";
const FARM_GARDENS_URL = "https://chainers.io/api/farm/user/gardens";
const ADD_VEGETABLES_TO_BLOCK_URL =
    "https://chainers.io/api/farm/reward-pools/add-vegetables-to-block";
const REWARD_POOLS_STATE_URL = "https://chainers.io/api/farm/reward-pools/active-blocks-data";

function parseVegetableItemTypesFromEnv() {
    const raw = process.env.CHAINERS_VEGETABLE_ITEM_TYPES;
    if (raw && String(raw).trim())
        return String(raw)
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
    return ["vegetables", "farmvegetables", "vegetable"];
}

function isVegetableInventoryItem(i) {
    if (!i?.itemCode || Number(i.count) <= 0) return false;
    if (i.itemType === "farmSeeds") return false;
    if (String(i.itemCode).endsWith("_seeds")) return false;

    const t = String(i.itemType || "").toLowerCase();
    const code = String(i.itemCode).toLowerCase();

    // STRICT: Only accept actual farm vegetables (not fertilizers, food, etc)
    if (t !== "farmvegetables") return false;

    // Must have rarity prefix and be actual produce
    if (!code.match(/^(common|uncommon|rare|legendary)_/)) return false;
    if (code.includes("_seeds") || code.includes("_food") || code.includes("_fertilizer")) return false;

    return true;
}

function isCsrfTokenExpired(csrfToken) {
    if (!csrfToken) return true;
    try {
        // CSRF token is URL-encoded JSON: {"expiration":"2026-04-25T11:55:17Z","token":"..."}
        const decoded = decodeURIComponent(csrfToken);
        const parsed = JSON.parse(decoded);
        if (parsed.expiration) {
            const expTime = new Date(parsed.expiration).getTime();
            const now = Date.now();
            // Consider expired if less than 30 seconds remaining
            return expTime - now < 30000;
        }
    } catch (e) {
        // If we can't parse, assume it's expired to be safe
        return true;
    }
    return false;
}

async function refreshCsrfTokenFromCookies(context) {
    try {
        const cookies = await context.cookies('https://chainers.io');
        const csrfCookie = cookies.find(c => c.name === 'x-csrf');
        if (csrfCookie?.value) {
            // Validate the new token isn't expired
            if (!isCsrfTokenExpired(csrfCookie.value)) {
                lastChainersApiHeaders['x-csrf'] = csrfCookie.value;
                console.log('🔄 Refreshed CSRF token from cookies');
                return true;
            }
        }
    } catch (e) {
        console.log('⚠️ Failed to refresh CSRF from cookies:', e.message);
    }
    return false;
}

async function chainersRequestHeaders(context, includeJsonContentType) {
    if (!lastChainersApiHeaders.authorization) return null;

    // Check if CSRF token is expired and try to refresh from cookies
    if (isCsrfTokenExpired(lastChainersApiHeaders["x-csrf"])) {
        if (context) {
            const refreshed = await refreshCsrfTokenFromCookies(context);
            if (!refreshed) {
                console.log("⚠️ CSRF token expired - waiting for fresh headers from game");
                return null;
            }
        } else {
            return null;
        }
    }

    const h = {
        authorization: lastChainersApiHeaders.authorization,
        accept: "application/json",
        origin: "https://static.chainers.io",
        referer: "https://static.chainers.io/",
        "x-request-token-id":
            lastChainersApiHeaders["x-request-token-id"] || crypto.randomBytes(8).toString("hex"),
    };
    if (lastChainersApiHeaders["x-csrf"]) h["x-csrf"] = lastChainersApiHeaders["x-csrf"];
    if (includeJsonContentType) h["content-type"] = "application/json";
    return h;
}

// ================= COOKIES =================
async function loadCookies(context) {
    try {
        let cookies = JSON.parse(fs.readFileSync("cookies.json", "utf-8"));

        cookies = cookies.map(c => {
            if (!["Strict", "Lax", "None"].includes(c.sameSite)) {
                c.sameSite = "Lax";
            }
            return c;
        });

        await context.addCookies(cookies);
    } catch {
        console.log("⚠️ No cookies file");
    }
}

// ================= BROWSER =================
async function createBrowser() {
    const useBundled =
        process.env.CHAINERS_USE_BUNDLED_CHROMIUM === "1" ||
        process.env.CHAINERS_USE_BUNDLED_CHROMIUM === "true";

    const launchOpts = {
        headless: false,
        args: [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-setuid-sandbox"
        ]
    };
    if (!useBundled) launchOpts.channel = "chrome";

    const browser = await chromium.launch(launchOpts);

    const contextOpts = {
        viewport: { width: 1280, height: 800 }
    };
    if (fs.existsSync(STORAGE_STATE_PATH)) {
        contextOpts.storageState = STORAGE_STATE_PATH;
        console.log("🗂 Restoring session from", STORAGE_STATE_PATH);
    } else {
        console.log("🗂 No saved session yet — will create", STORAGE_STATE_PATH, "after login");
    }

    const context = await browser.newContext(contextOpts);
    const page = await context.newPage();

    await loadCookies(context);

    await page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", {
            get: () => false,
        });
    });

    return { browser, context, page };
}

// ================= HUMAN SIM =================
async function humanBehavior(page) {
    await page.mouse.move(rand(100, 500), rand(100, 500));
    await page.mouse.move(rand(500, 900), rand(200, 700));
    await page.mouse.wheel(0, rand(200, 800));
    await sleep(rand(1000, 3000));
}

// ================= LISTENERS =================
function attachChainersApiHeaderSniffer(context) {
    context.on("request", (req) => {
        const url = req.url();
        if (!url.includes("chainers.io/api/")) return;
        const h = req.headers();
        if (!h.authorization) return;
        lastChainersApiHeaders = {
            authorization: h.authorization,
            "x-csrf": h["x-csrf"] ?? "",
            "x-request-token-id": h["x-request-token-id"] ?? "",
        };
    });
}

/** Remember reward pool block id from game traffic or your manual POST. */
function attachRewardPoolBlockSniffer(context) {
    context.on("request", (req) => {
        const url = req.url();
        if (!url.includes("add-vegetables-to-block")) return;
        try {
            const body = req.postData();
            if (!body) return;
            const j = JSON.parse(body);
            if (typeof j.rewardsPoolsBlocksID === "string" && j.rewardsPoolsBlocksID.length > 8) {
                if (lastRewardPoolBlockId !== j.rewardsPoolsBlocksID) {
                    console.log("🎯 Captured reward pool block ID:", j.rewardsPoolsBlocksID.slice(0, 12) + "…");
                }
                lastRewardPoolBlockId = j.rewardsPoolsBlocksID;
            }
        } catch {
            /* ignore */
        }
    });
}

function pickFarmingId(obj) {
    if (!obj || typeof obj !== "object") return null;
    const id =
        obj.userFarmingID ||
        obj.userFarmingId ||
        obj.farmingID ||
        obj.farmingId ||
        obj.user_farming_id;
    if (typeof id === "string" && id.length > 4) return id;
    const gardenLike = obj.placedBeds || "isCollectHarvestAvailable" in obj;
    if (gardenLike && typeof obj._id === "string" && obj._id.length >= 20) return obj._id;
    return null;
}

function walkFarmNodes(data, visitor) {
    if (!data || typeof data !== "object") return;
    if (Array.isArray(data.data)) {
        for (const item of data.data) visitor(item);
        return;
    }
    if (data.data && typeof data.data === "object") visitor(data.data);
}

function deepFindUserFarmingId(obj, depth = 5) {
    if (!obj || typeof obj !== "object" || depth < 0) return null;
    const direct = pickFarmingId(obj);
    if (direct) return direct;
    for (const v of Object.values(obj)) {
        if (v && typeof v === "object") {
            const found = deepFindUserFarmingId(v, depth - 1);
            if (found) return found;
        }
    }
    return null;
}

function looksLikeFarmGardenPayload(data) {
    if (!data?.data) return false;
    if (Array.isArray(data.data)) return data.data.some((n) => n?.placedBeds != null);
    if (typeof data.data === "object") return data.data.placedBeds != null;
    return false;
}

function extractCandidateFarmingIdsFromGardensPayload(data) {
    const out = [];
    if (!Array.isArray(data?.data)) return out;
    const now = Date.now();
    for (const garden of data.data) {
        if (!Array.isArray(garden?.placedBeds)) continue;
        for (const bed of garden.placedBeds) {
            const id = bed?.plantedSeed?.userFarmingID;
            if (typeof id !== "string" || id.length < 5) continue;
            const growthDate = bed?.plantedSeed?.dateGrowth;
            if (growthDate) {
                const at = Date.parse(growthDate);
                if (Number.isFinite(at) && at > now) continue;
            }
            out.push(id);
        }
    }
    return [...new Set(out)];
}

function extractBedsMetadataFromGardensPayload(data) {
    const emptyBeds = [];
    const bedGardenMap = {};
    if (!Array.isArray(data?.data)) return { emptyBeds, bedGardenMap };

    for (const garden of data.data) {
        const userGardensID = garden?.userGardensID;
        if (typeof userGardensID !== "string" || !Array.isArray(garden?.placedBeds)) continue;

        for (const bed of garden.placedBeds) {
            const userBedsID = bed?.userBedsID;
            if (typeof userBedsID !== "string" || userBedsID.length < 5) continue;
            bedGardenMap[userBedsID] = userGardensID;

            const plantedSeedId = bed?.plantedSeed?.userFarmingID;
            if (!plantedSeedId) emptyBeds.push({ userGardensID, userBedsID });
        }
    }

    return { emptyBeds, bedGardenMap };
}

/** Beds that grow harvestable vegetables (excludes bird coops etc.). */
function isVegetablePlotBed(bed) {
    const c = String(bed?.itemCode || "");
    if (!c) return false;
    if (/bird|coop|chicken|livestock|barn/i.test(c) && !c.includes("plot")) return false;
    return c.includes("vegetable_plot");
}

function formatRoughDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "soon";
    const m = Math.ceil(ms / 60000);
    if (m < 60) return `~${m}m`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? `~${h}h ${rm}m` : `~${h}h`;
}

/**
 * When canHarvest is false but every vegetable plot has a crop still before dateGrowth,
 * everything is simply waiting to mature.
 */
function analyzeVegetablePlotsGrowthState(gardensPayload, harvestFlag) {
    const now = Date.now();
    const out = {
        vegPlots: 0,
        empty: 0,
        growing: 0,
        ripe: 0,
        nextReadyAt: null,
        allGrowingNoHarvest: false,
    };
    if (!Array.isArray(gardensPayload?.data)) return out;

    for (const garden of gardensPayload.data) {
        if (!Array.isArray(garden?.placedBeds)) continue;
        for (const bed of garden.placedBeds) {
            if (!isVegetablePlotBed(bed)) continue;
            out.vegPlots++;
            const ps = bed.plantedSeed;
            if (!ps?.userFarmingID) {
                out.empty++;
                continue;
            }
            const at = Date.parse(ps.dateGrowth);
            if (Number.isFinite(at) && at > now) {
                out.growing++;
                if (out.nextReadyAt == null || at < out.nextReadyAt) out.nextReadyAt = at;
            } else {
                out.ripe++;
            }
        }
    }

    out.allGrowingNoHarvest =
        out.vegPlots > 0 &&
        out.empty === 0 &&
        out.growing === out.vegPlots &&
        out.ripe === 0 &&
        !harvestFlag;

    return out;
}

function applyFarmPayload(data) {
    if (!data || typeof data !== "object") return;

    // Track harvest availability from garden/root level AND individual beds
    let harvestFlagFromRoot = null;
    let harvestFlagFromBeds = false;

    walkFarmNodes(data, (node) => {
        if (!node || typeof node !== "object") return;
        const id = pickFarmingId(node);
        if (id) userFarmingID = id;
        // Check root/garden level isCollectHarvestAvailable
        if ("isCollectHarvestAvailable" in node && !node.plantedSeed && !node.userBedsID) {
            harvestFlagFromRoot = !!node.isCollectHarvestAvailable;
        }
        // Also check bed level (plantedSeed.isCollectHarvestAvailable)
        if (node.plantedSeed?.isCollectHarvestAvailable === true) {
            harvestFlagFromBeds = true;
        }
    });

    // Apply harvest flag if found at root level OR any bed is ready
    if (harvestFlagFromRoot !== null) {
        canHarvest = harvestFlagFromRoot;
    }
    if (harvestFlagFromBeds) {
        canHarvest = true;
    }

    if (typeof data.userFarmingID === "string") userFarmingID = data.userFarmingID;

    if (looksLikeFarmGardenPayload(data)) {
        lastGardensData = data;
        const deepId = deepFindUserFarmingId(data);
        if (deepId) userFarmingID = deepId;
        candidateFarmingIDs = extractCandidateFarmingIdsFromGardensPayload(data);
        const meta = extractBedsMetadataFromGardensPayload(data);
        emptyBedsCache = meta.emptyBeds;
        bedToGardenMap = meta.bedGardenMap;
        if (!userFarmingID && candidateFarmingIDs.length) {
            userFarmingID = candidateFarmingIDs[0];
        }
    }
}

function logFarmStateIfChanged() {
    const logKey = `${canHarvest}|${userFarmingID || ""}`;
    if (logKey !== lastFarmLogKey) {
        lastFarmLogKey = logKey;
        console.log(
            "🌾 Harvest available:",
            canHarvest,
            userFarmingID ? `(farm ${userFarmingID.slice(0, 8)}…)` : "(no id in payload yet)"
        );
    }
}

function attachFarmListener(context) {
    context.on("response", async (res) => {
        try {
            if (!res.url().includes("/api/farm")) return;

            const status = res.status();
            if (status === 304 || status === 204) return;

            const ct = (res.headers()["content-type"] || "").toLowerCase();
            if (ct && !ct.includes("json")) return;

            let data;
            try {
                data = await res.json();
            } catch {
                return;
            }

            applyFarmPayload(data);
            logFarmStateIfChanged();
        } catch { }
    });
}

/**
 * Inventory GET does not include userFarmingID (only seeds/items).
 * Uses cache-busting so we get JSON, not 304 with an empty body.
 */
async function fetchFarmInventory(context, { minIntervalMs = TIMING.inventoryMinInterval, silent = false } = {}) {
    const now = Date.now();
    if (now - lastInventoryFetchAt < minIntervalMs) return cachedFarmSeeds;
    const headers = await chainersRequestHeaders(context, false);
    if (!headers) return cachedFarmSeeds;

    const start = Date.now();
    lastInventoryFetchAt = now;
    headers["cache-control"] = "no-cache";
    headers["pragma"] = "no-cache";

    const res = await context.request.get(FARM_INVENTORY_URL, { headers, timeout: TIMING.apiTimeout });
    const status = res.status();
    if (status === 304 || status === 204) {
        perfLog("fetchInventory", Date.now() - start, false, { status, cached: true });
        return cachedFarmSeeds;
    }

    const text = await res.text();
    if (!text?.trim()) {
        perfLog("fetchInventory", Date.now() - start, false, { empty: true });
        return cachedFarmSeeds;
    }

    let data;
    try {
        data = JSON.parse(text);
    } catch {
        perfLog("fetchInventory", Date.now() - start, false, { parseError: true });
        return cachedFarmSeeds;
    }

    const items = data?.data?.items;
    if (!Array.isArray(items)) {
        perfLog("fetchInventory", Date.now() - start, false, { noItems: true });
        return cachedFarmSeeds;
    }

    cachedFarmSeeds = items
        .filter((i) => {
            const type = String(i?.itemType || "").toLowerCase();
            const code = String(i?.itemCode || "").toLowerCase();
            const count = Number(i.count);
            // Must be farmSeeds type, have count, and actually be a seed (not food)
            return type === "farmseeds" && count > 0 && code.includes("_seeds");
        })
        .map((i) => ({ itemID: i.itemID || i.id || i._id || i.itemId, itemCode: i.itemCode, count: Number(i.count) }));

    // Log seed inventory summary
    if (cachedFarmSeeds.length > 0 && !silent) {
        const codes = cachedFarmSeeds.map((s) => `${s.itemCode}×${s.count}`).slice(0, 6);
        console.log("📦 Seeds:", codes.join(", "), cachedFarmSeeds.length > 6 ? "…" : "");
    }

    // Debug: show all inventory items before filtering
    if (process.env.CHAINERS_DEBUG_POOL === "1") {
        console.log("🔍 Pool debug - ALL inventory items:", items.map(i => ({
            itemCode: i.itemCode,
            itemType: i.itemType,
            count: i.count,
            isVegetable: isVegetableInventoryItem(i)
        })));
    }

    cachedVegetables = items
        .filter((i) => isVegetableInventoryItem(i))
        .map((i) => ({ itemID: i.itemID, itemCode: i.itemCode, itemType: i.itemType, count: Number(i.count) }));

    const totalSeeds = cachedFarmSeeds.reduce((sum, s) => sum + s.count, 0);
    const seedTypes = cachedFarmSeeds.length;
    aiLog("inventory", { seedTypes, totalSeeds, seeds: cachedFarmSeeds.map(s => ({ code: s.itemCode, count: s.count })) });
    perfLog("fetchInventory", Date.now() - start, true, { seedTypes, totalSeeds });

    return cachedFarmSeeds;
}

/**
 * Gardens endpoint contains current farm state and userFarmingID.
 * Use cache-busting query + no-cache headers to avoid 304 empty body.
 */
async function fetchFarmGardens(context, { minIntervalMs = TIMING.gardenMinInterval, silent = false } = {}) {
    const now = Date.now();
    if (now - lastGardenFetchAt < minIntervalMs) return null;
    const headers = await chainersRequestHeaders(context, false);
    if (!headers) return null;

    const start = Date.now();
    lastGardenFetchAt = now;
    headers["cache-control"] = "no-cache";
    headers.pragma = "no-cache";

    const url = `${FARM_GARDENS_URL}?_=${now}`;
    const res = await context.request.get(url, { headers, timeout: TIMING.apiTimeout });
    const status = res.status();
    if (status === 304 || status === 204) {
        perfLog("fetchGardens", Date.now() - start, false, { status, cached: true });
        return null;
    }

    const text = await res.text();
    if (!text?.trim()) {
        perfLog("fetchGardens", Date.now() - start, false, { empty: true });
        return null;
    }

    let data;
    try {
        data = JSON.parse(text);
    } catch {
        perfLog("fetchGardens", Date.now() - start, false, { parseError: true });
        return null;
    }

    applyFarmPayload(data);
    const readyBeds = data?.data?.reduce((sum, g) => sum + (g?.placedBeds?.filter(b => b?.plantedSeed?.isCollectHarvestAvailable)?.length || 0), 0);
    aiLog("gardens", { readyBeds, totalBeds: emptyBedsCache.length + (readyBeds || 0), canHarvest, hasFarmingId: !!userFarmingID });
    perfLog("fetchGardens", Date.now() - start, true, { readyBeds });
    if (!silent) logFarmStateIfChanged();
    return data;
}

const COLLECT_HARVEST_URL = "https://chainers.io/api/farm/control/collect-harvest";
const PLANT_SEED_URL = "https://chainers.io/api/farm/control/plant-seed";
const DAILY_REWARDS_URL = "https://chainers.io/api/main/daily-rewards/claim-current-day-reward";
const WHEEL_OF_FORTUNE_STATE_URL = "https://chainers.io/api/main/fortune-games/user-game-state?code=wheel-of-fortune";
const WHEEL_OF_FORTUNE_PLAY_URL = "https://proxy.chainers.io/fortune_games.FortuneGamesService/Play";

function tryParseJson(text) {
    if (!text || typeof text !== "string") return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function normalizeHarvestResultFromApi(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.userBedsID === "string" && typeof raw.userFarmingID === "string") return raw;
    if (raw.data && typeof raw.data === "object") {
        const d = raw.data;
        if (typeof d.userBedsID === "string" && typeof d.userFarmingID === "string") return d;
    }
    return null;
}

async function collectHarvestViaApi(context, farmingId = userFarmingID) {
    if (!farmingId) return { ok: false, reason: "no userFarmingID yet" };
    const headers = await chainersRequestHeaders(context, true);
    if (!headers) return { ok: false, reason: "no API headers yet (wait for game requests)" };

    const start = Date.now();
    const res = await context.request.post(COLLECT_HARVEST_URL, {
        headers,
        data: JSON.stringify({ userFarmingID: farmingId }),
        timeout: TIMING.apiTimeout
    });

    const status = res.status();
    const text = await res.text();
    const json = tryParseJson(text);
    const ok = res.ok();
    const retryAfter = parseRetryAfterSec(res.headers());
    const harvestData = normalizeHarvestResultFromApi(json);
    const duration = Date.now() - start;

    const gains = harvestData?.harvest?.map(h => ({ code: h.code || h.type, count: h.count || 0 })) || [];
    aiLog("harvest_api", { ok, farmingId: farmingId.slice(0, 8), status, gains, ms: duration });
    perfLog("harvestApi", duration, ok, { status, farmingId: farmingId.slice(0, 8) });

    if (ok) {
        metrics.harvestsTotal++;
        metrics.harvestsApi++;
        updateSuccessRate(true);
    }

    return { ok, status, text, json, harvestData, retryAfter, duration };
}

function parseRetryAfterSec(headers) {
    const raw = headers["retry-after"];
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
}

function isHarvestNotReadyError(status, text) {
    if (status !== 400 || !text) return false;
    const s = String(text).toLowerCase();
    return (
        s.includes("not found usersfarming") ||
        s.includes("not growth yet") ||
        s.includes('"errorcode":"incorrect_parameter"')
    );
}

async function tryPlantViaApi(context, userGardensID, userBedsID, seedID, seedCode) {
    const headers = await chainersRequestHeaders(context, true);
    if (!headers || !userGardensID || !userBedsID || !seedID) {
        console.log(`❌ Plant missing data: garden=${!!userGardensID}, bed=${!!userBedsID}, seed=${!!seedID} (ID: ${seedID})`);
        return { ok: false, status: 0 };
    }

    const start = Date.now();
    // Plant API needs userGardensID (not userFarmingID) + seedCode
    const payload = { userGardensID, userBedsID, seedID, seedCode };
    const res = await context.request.post(PLANT_SEED_URL, {
        headers,
        data: JSON.stringify(payload),
        timeout: TIMING.apiTimeout
    });
    const status = res.status();
    const text = await res.text();
    const ok = res.ok();
    const duration = Date.now() - start;

    aiLog("plant_api", { ok, bedId: userBedsID.slice(0, 8), seedCode, status, ms: duration });
    perfLog("plantApi", duration, ok, { status, bedId: userBedsID.slice(0, 8) });

    if (ok) {
        metrics.plantsTotal++;
        metrics.plantsApi++;
        return { ok: true, status, text, duration };
    }
    if (status === 429) {
        metrics.rateLimitsHit++;
        return { ok: false, status, text, retryAfter: parseRetryAfterSec(res.headers()), duration };
    }
    // Log error details for debugging
    if (status === 400 || status === 401 || status === 403) {
        console.log(`❌ Plant API error: ${status} - ${text?.slice(0, 100)}`);
    }
    return { ok: false, status, text, duration };
}

async function batchPlantViaApi(context, beds, seeds) {
    if (!beds?.length || !seeds?.length) return { planted: 0, beds: [], failed: 0, rateLimited: false };
    const results = { planted: 0, beds: [], failed: 0, rateLimited: false };
    const seedQueue = [...seeds];
    const start = Date.now();
    for (const bed of beds) {
        const seed = seedQueue.find(s => s.count > 0);
        if (!seed) break;
        const res = await tryPlantViaApi(context, bed.userGardensID, bed.userBedsID, seed.itemID, seed.itemCode);
        if (res.ok) {
            seed.count--;
            results.planted++;
            results.beds.push(bed.userBedsID);
            await sleep(rand(100, 300)); // Faster planting
        } else if (res.status === 429) {
            results.rateLimited = true;
            results.retryAfter = res.retryAfter;
            break;
        } else if (res.status === 400) {
            results.failed++;
            continue;
        } else {
            results.failed++;
        }
    }
    aiLog("batch_plant", { planted: results.planted, failed: results.failed, rateLimited: results.rateLimited, ms: Date.now() - start });
    return results;
}

const DEFAULT_MAX_VEGETABLES_PER_DEPOSIT = 40;

async function depositStoredVegetablesToRewardPool(context) {
    let blockId = lastRewardPoolBlockId;
    // Try to get from env if not captured from API
    if (!blockId) {
        blockId = process.env.CHAINERS_REWARD_POOL_BLOCK_ID || process.env.CHAINERS_REWARDS_POOLS_BLOCKS_ID || "";
    }
    // Try to fetch current IBNB block ID from API if not available
    if (!blockId) {
        try {
            const headers = await chainersRequestHeaders(context, false);
            if (headers) {
                const res = await context.request.get(REWARD_POOLS_STATE_URL, { headers, timeout: 10000 });
                const json = await res.json().catch(() => null);
                // Find IBNB block from active blocks list
                const blocks = json?.data || [];
                const ibnbBlock = blocks.find(b => b.currency === "IBNB" || b.rewardPoolCode?.includes("BNB"));
                if (ibnbBlock?.id) {
                    blockId = ibnbBlock.id;
                    lastRewardPoolBlockId = blockId;
                    console.log("📦 Auto-fetched IBNB reward pool block ID:", blockId.slice(0, 8) + "…", "(Currency:", ibnbBlock.currency + ")");
                }
            }
        } catch (e) {
            // Silent fail - will show skip message below
        }
    }

    if (!blockId) {
        console.log("ℹ️ Reward pool: skip deposit — no rewardsPoolsBlocksID. Set CHAINERS_REWARD_POOL_BLOCK_ID env var or deposit once in-game");
        aiLog("pool_skip", { reason: "no_block_id" });
        return;
    }

    console.log("🥕 Reward pool: using block", blockId.slice(0, 8) + "…");

    await fetchFarmInventory(context, { minIntervalMs: 0, silent: true });

    // Debug: log what we have in cached vegetables
    if (process.env.CHAINERS_DEBUG_POOL === "1") {
        console.log("🔍 Pool debug - cached vegetables:", cachedVegetables.map(v => ({ code: v.itemCode, type: v.itemType, count: v.count })));
    }

    const vegetables = cachedVegetables
        .filter((v) => v.itemCode && Number(v.count) > 0)
        .map((v) => ({ itemCode: v.itemCode, count: Number(v.count) }));

    if (process.env.CHAINERS_DEBUG_POOL === "1") {
        console.log("🔍 Pool debug - filtered vegetables:", vegetables);
    }

    if (process.env.CHAINERS_DEBUG_POOL === "1") {
        console.log("🔍 Pool debug - filtered vegetables:", vegetables);
    }

    if (!vegetables.length) {
        aiLog("pool_skip", { reason: "no_vegetables", cached: cachedVegetables.length });
        return;
    }

    const headers = await chainersRequestHeaders(context, true);
    if (!headers) return;

    const maxPer = Number.parseInt(process.env.CHAINERS_REWARD_POOL_MAX_ITEMS_PER_REQUEST || "", 10) || DEFAULT_MAX_VEGETABLES_PER_DEPOSIT;

    let totalDeposited = 0;
    const start = Date.now();
    for (let i = 0; i < vegetables.length; i += maxPer) {
        const chunk = vegetables.slice(i, i + maxPer);
        const payload = { rewardsPoolsBlocksID: blockId, vegetables: chunk };
        console.log("🔍 Pool payload:", JSON.stringify(payload).slice(0, 200));
        const res = await context.request.post(ADD_VEGETABLES_TO_BLOCK_URL, {
            headers,
            data: JSON.stringify(payload),
            timeout: TIMING.apiTimeout
        });
        const status = res.status();
        const text = await res.text();
        const json = tryParseJson(text);
        const ok = res.ok();
        const duration = Date.now() - start;

        if (ok) {
            totalDeposited += chunk.reduce((s, x) => s + x.count, 0);
            const summary = chunk.map((x) => `${x.itemCode}×${x.count}`).join(", ");
            console.log("🥕 Reward pool deposit OK", status, summary.slice(0, 120), chunk.length > 3 ? "…" : "");
            aiLog("pool_deposit", { ok: true, blockId: blockId.slice(0, 8), items: chunk.length, total: totalDeposited, ms: duration });
            perfLog("poolDeposit", duration, true, { items: chunk.length });
            for (const row of chunk) {
                const c = cachedVegetables.find((v) => v.itemCode === row.itemCode);
                if (c) c.count = Math.max(0, Number(c.count) - row.count);
            }
        } else if (json?.errorCode === "INCORRECT_PARAMETER" && json?.error?.includes("not found")) {
            // Block ID is invalid - clear it and skip
            console.log("⚠️ Reward pool block not found (invalid/expired). Clearing block ID.");
            aiLog("pool_deposit", { ok: false, status, error: "block_not_found", blockId: blockId.slice(0, 8) });
            lastRewardPoolBlockId = "";
            break;
        } else if (status === 429) {
            const waitSec = parseRetryAfterSec(res.headers()) ?? rand(10, 20);
            metrics.rateLimitsHit++;
            console.log(`⚠️ Reward pool deposit rate limited (429) — backing off ~${waitSec}s`);
            aiLog("pool_deposit", { ok: false, blockId: blockId.slice(0, 8), status: 429, ms: duration });
            perfLog("poolDeposit", duration, false, { status: 429 });
            await sleep(waitSec * 1000);
            break;
        } else {
            console.log("⚠️ Reward pool deposit failed", status, text?.slice(0, 200));
            aiLog("pool_deposit", { ok: false, blockId: blockId.slice(0, 8), status, ms: duration });
            perfLog("poolDeposit", duration, false, { status });
            break;
        }
        await sleep(rand(200, 500));
    }

    if (totalDeposited > 0) {
        cachedVegetables = cachedVegetables.filter((v) => Number(v.count) > 0);
    }
}

async function claimDailyReward(context) {
    const eventId = process.env.CHAINERS_DAILY_REWARD_EVENT_ID || "69cbe94bf11d295b6fb7e651";
    const headers = await chainersRequestHeaders(context, true);
    if (!headers) {
        console.log("ℹ️ Daily reward: skip — no API headers yet");
        return;
    }

    const start = Date.now();
    try {
        const res = await context.request.post(DAILY_REWARDS_URL, {
            headers,
            data: JSON.stringify({ dailyRewardsEventsID: eventId }),
            timeout: TIMING.apiTimeout
        });
        const status = res.status();
        const text = await res.text();
        const json = tryParseJson(text);
        const ok = res.ok() && json?.success === true;
        const duration = Date.now() - start;

        if (ok) {
            const cards = json?.data?.boosterReceivedCards || [];
            const rewards = cards.map(c => `${c.rarity}×${c.count}`).join(", ") || "reward claimed";
            console.log("🎁 Daily reward claimed:", rewards);
            aiLog("daily_reward", { ok: true, rewards: cards.map(c => ({ rarity: c.rarity, count: c.count })), ms: duration });
            perfLog("dailyReward", duration, true, { items: cards.length });
        } else if (status === 400 && text?.includes("already claimed")) {
            console.log("🎁 Daily reward: already claimed today");
            aiLog("daily_reward", { ok: true, status: "already_claimed", ms: duration });
        } else if (status === 429) {
            console.log("⚠️ Daily reward rate limited (429)");
            aiLog("daily_reward", { ok: false, status: 429, ms: duration });
        } else {
            console.log("⚠️ Daily reward failed:", status, text?.slice(0, 100));
            aiLog("daily_reward", { ok: false, status, ms: duration });
        }
    } catch (e) {
        const duration = Date.now() - start;
        console.log("⚠️ Daily reward error:", String(e?.message || e).slice(0, 50));
        aiLog("daily_reward", { ok: false, error: String(e?.message || e).slice(0, 50), ms: duration });
    }
}

async function getWheelOfFortuneBids(context) {
    const headers = await chainersRequestHeaders(context, false);
    if (!headers) return [];
    try {
        const res = await context.request.get(WHEEL_OF_FORTUNE_STATE_URL, { headers, timeout: TIMING.apiTimeout });
        const json = await res.json().catch(() => null);
        if (json?.success && Array.isArray(json?.data?.availableFortuneGamesBids)) {
            return json.data.availableFortuneGamesBids;
        }
        return [];
    } catch (e) {
        return [];
    }
}

async function playWheelOfFortuneViaPage(page, bidId) {
    if (!bidId) return { ok: false, error: "no bid id" };
    const start = Date.now();
    try {
        // The proxy uses protobuf gRPC-web, so we use page fetch with the encoded payload
        const result = await page.evaluate(async (id) => {
            try {
                // Build protobuf message with bid IDs
                // Message format: repeated string bidIDs = 1;
                const encodeBid = (bid) => {
                    const bytes = new TextEncoder().encode(bid);
                    const len = bytes.length;
                    // Protobuf field 1, wire type 2 (length-delimited): (1 << 3) | 2 = 0x0a
                    const buf = new Uint8Array(1 + 1 + len);
                    buf[0] = 0x0a; // field tag
                    buf[1] = len;  // length
                    buf.set(bytes, 2);
                    return buf;
                };

                // Encode the bid ID
                const bidBytes = encodeBid(id);

                // gRPC-web framing: 5-byte header + protobuf message
                // Byte 0: 0x00 = data frame (not compressed)
                // Bytes 1-4: 32-bit big-endian length of protobuf message
                const frame = new Uint8Array(5 + bidBytes.length);
                frame[0] = 0x00; // uncompressed data frame
                const msgLen = bidBytes.length;
                frame[1] = (msgLen >> 24) & 0xff;
                frame[2] = (msgLen >> 16) & 0xff;
                frame[3] = (msgLen >> 8) & 0xff;
                frame[4] = msgLen & 0xff;
                frame.set(bidBytes, 5);

                // Convert to base64
                const base64 = btoa(String.fromCharCode(...frame));

                const r = await fetch("https://proxy.chainers.io/fortune_games.FortuneGamesService/Play", {
                    method: "POST",
                    credentials: "include",
                    headers: {
                        "accept": "application/grpc-web-text",
                        "content-type": "application/grpc-web-text",
                        "x-grpc-web": "1"
                    },
                    body: base64
                });
                const text = await r.text();
                return { ok: r.ok, status: r.status, text: text.slice(0, 200) };
            } catch (e) {
                return { ok: false, error: String(e?.message || e) };
            }
        }, bidId);
        const duration = Date.now() - start;
        return { ...result, duration };
    } catch (e) {
        return { ok: false, error: String(e?.message || e), duration: Date.now() - start };
    }
}

async function playAllWheelOfFortune(page, context) {
    if (process.env.CHAINERS_SKIP_WHEEL_OF_FORTUNE === "1") return;
    const bids = await getWheelOfFortuneBids(context);
    if (!bids.length) return;

    console.log("🎰 Wheel of Fortune:", bids.length, "spins available");
    aiLog("wheel_of_fortune_start", { bids: bids.length });

    for (const bid of bids) {
        const res = await playWheelOfFortuneViaPage(page, bid.id);
        if (res.ok) {
            console.log("🎰 Spin played:", bid.id.slice(0, 8) + "…");
            aiLog("wheel_of_fortune_spin", { ok: true, bidId: bid.id.slice(0, 8), ms: res.duration });
            perfLog("wheelSpin", res.duration, true);
        } else if (res.status === 429) {
            console.log("⚠️ Wheel of Fortune rate limited");
            aiLog("wheel_of_fortune_spin", { ok: false, status: 429 });
            break;
        } else {
            console.log("⚠️ Wheel spin failed:", res.error || res.status);
            aiLog("wheel_of_fortune_spin", { ok: false, error: res.error?.slice(0, 50) });
        }
        await sleep(rand(500, 1000));
    }
}

async function collectHarvestViaPageFetch(page, farmingId) {
    if (!farmingId) return { ok: false, status: 0, text: "no farmingId" };
    const start = Date.now();
    try {
        const result = await page.evaluate(
            async (id) => {
                const r = await fetch("https://chainers.io/api/farm/control/collect-harvest", {
                    method: "POST",
                    credentials: "include",
                    headers: { "content-type": "application/json", accept: "application/json" },
                    body: JSON.stringify({ userFarmingID: id }),
                });
                return { ok: r.ok, status: r.status, text: await r.text() };
            },
            farmingId
        );
        const duration = Date.now() - start;
        perfLog("harvestPage", duration, result.ok, { status: result.status });
        if (result.ok) { metrics.harvestsTotal++; metrics.harvestsPage++; }
        return { ...result, duration };
    } catch (e) {
        const duration = Date.now() - start;
        perfLog("harvestPage", duration, false, { error: String(e?.message || e).slice(0, 50) });
        return { ok: false, status: 0, text: String(e?.message || e), duration };
    }
}

// ================= CLOUDFLARE DETECT =================
async function waitForCloudflare(page) {
    console.log("🛡️ Waiting Cloudflare...");

    for (let i = 0; i < 60; i++) {
        const title = await page.title().catch(() => "");
        const loweredTitle = title.toLowerCase();

        if (
            title &&
            !loweredTitle.includes("verify") &&
            !loweredTitle.includes("security")
        ) {
            console.log("✅ Cloudflare passed");
            return true;
        }

        await humanBehavior(page);
        await sleep(2000);
    }

    console.log("⚠️ Cloudflare not passed → manual solve needed");
    return false;
}

// ================= HARVEST UI =================
async function focusFarmCanvas(page) {
    const canvases = await page.$$("canvas");
    const c = canvases[0];
    if (!c) return;
    const box = await c.boundingBox();
    if (!box) return;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(rand(400, 900));
}

async function tryClickHarvestInFrame(frame) {
    const locators = [
        frame.getByRole("button", { name: /harvest/i }),
        frame.locator("button, a, [role='button']").filter({ hasText: /^harvest$/i }),
        frame.locator("button, a, [role='button']").filter({ hasText: /harvest/i }),
        frame.getByText(/harvest/i, { exact: false }),
    ];

    for (const loc of locators) {
        const el = loc.first();
        try {
            await el.waitFor({ state: "visible", timeout: 8000 });
            await el.scrollIntoViewIfNeeded();
            await el.click({ timeout: 12000 });
            return true;
        } catch {
            try {
                await el.click({ timeout: 5000, force: true });
                return true;
            } catch {
                /* next locator */
            }
        }
    }
    return false;
}

async function clickHarvest(page) {
    const frames = page.frames();
    const deadline = Date.now() + TIMING.harvestClickTimeout;
    const start = Date.now();
    for (let attempt = 0; Date.now() < deadline; attempt++) {
        if (attempt % 4 === 0) await focusFarmCanvas(page);
        for (const frame of frames) {
            if (await tryClickHarvestInFrame(frame)) {
                const duration = Date.now() - start;
                perfLog("harvestUi", duration, true, { attempts: attempt + 1 });
                metrics.harvestsTotal++;
                metrics.harvestsUi++;
                return true;
            }
        }
        await sleep(600);
    }
    const duration = Date.now() - start;
    perfLog("harvestUi", duration, false, { timeout: true });
    return false;
}

// ================= NAVIGATION =================
async function safeGoto(page) {
    await page.goto("https://chainers.io/game/farm", {
        waitUntil: "domcontentloaded",
        timeout: 60000
    });

    await humanBehavior(page);

    const ok = await waitForCloudflare(page);
    return ok;
}

// ================= MAIN =================
async function runBot() {
    for (; ;) {
        console.log("🚀 BOT START");

        let browser;
        let context;
        let page;
        try {
            ({ browser, context, page } = await createBrowser());
        } catch (e) {
            console.log("💥 Failed to start Chrome:", e?.message || e);
            console.log("Tip: install Google Chrome, or run: CHAINERS_USE_BUNDLED_CHROMIUM=1 node bot_chainners.js");
            await sleep(5000);
            continue;
        }

        attachChainersApiHeaderSniffer(context);
        attachRewardPoolBlockSniffer(context);
        attachFarmListener(context);

        const ok = await safeGoto(page);

        if (!ok) {
            if (HAS_TTY_STDIN) {
                console.log("👉 Solve Cloudflare manually in the open window, then press ENTER...");
                await new Promise((resolve) => process.stdin.once("data", resolve));
            } else {
                console.log("👉 Solve Cloudflare manually in the open window, then wait for retry checks...");
            }
            const passed = await waitForCloudflare(page);
            if (!passed) {
                console.log("⚠️ Still blocked — closing browser and restarting...");
                await saveStorageState(context);
                await browser.close().catch(() => { });
                await sleep(2000);
                continue;
            }
        }

        console.log("✅ Login success");
        await saveStorageState(context);

        // Claim daily reward on first run (if not disabled)
        if (process.env.CHAINERS_SKIP_DAILY_REWARD !== "1") {
            await claimDailyReward(context);
        }

        // Play Wheel of Fortune (atom caster) if spins available
        await playAllWheelOfFortune(page, context);

        // Listen for Enter key to skip next cycle (TTY only).
        if (HAS_TTY_STDIN && !hasSkipInputListener) {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on("data", (data) => {
                if (data[0] === 0x0d || data[0] === 0x0a) {
                    skipNextCycle = true;
                    console.log("⏭️ Skip flag set — will skip next harvest/plant cycle");
                }
            });
            hasSkipInputListener = true;
        }

        await fetchFarmGardens(context, { minIntervalMs: 0 });
        await fetchFarmInventory(context, { minIntervalMs: 0 });

        while (true) {
            try {
                if (page.isClosed()) throw new Error("Page closed");

                if (!canHarvest) {
                    await fetchFarmGardens(context, { minIntervalMs: TIMING.harvestCheckInterval, silent: true });
                    let waitTime = adaptiveWait([5000, 10000]); // Check more frequently
                    let suffix = "";
                    let shouldShutdown = false;
                    if (lastGardensData) {
                        const growth = analyzeVegetablePlotsGrowthState(lastGardensData, canHarvest);
                        if (growth.allGrowingNoHarvest) {
                            if (growth.nextReadyAt) {
                                const msLeft = growth.nextReadyAt - Date.now();
                                suffix = ` — next crop ${formatRoughDuration(msLeft)}`;
                                // Shutdown if next crop > 5 minutes (300000ms)
                                if (msLeft > 300000) {
                                    console.log(`⏹️ Next crop in ${formatRoughDuration(msLeft)} (>5min), shutting down`);
                                    aiLog("shutdown", { reason: "next_crop_far", msLeft, nextReadyAt: new Date(growth.nextReadyAt).toISOString() });
                                    await browser.close().catch(() => { });
                                    process.exit(0);
                                }
                                // Wait until close to ready, but check at least every 30s
                                if (msLeft > 5000) {
                                    waitTime = Math.min(msLeft - 3000, 30000);
                                }
                            } else {
                                suffix = " — all growing";
                            }
                        } else if (growth.vegPlots > 0 && growth.empty > 0) {
                            suffix = ` — ${growth.empty} empty plot(s)`;
                            // Plant in empty beds even when no harvest is ready
                            if (emptyBedsCache.length > 0) {
                                await fetchFarmInventory(context, { minIntervalMs: 0, silent: true });
                                if (cachedFarmSeeds.length > 0) {
                                    console.log("🌱 PLANTING (no harvest ready, but empty plots available)");
                                    const plantResult = await batchPlantViaApi(context, emptyBedsCache.slice(0, 40), cachedFarmSeeds);
                                    if (plantResult.planted > 0) {
                                        console.log(`✅ Planted ${plantResult.planted} seeds`);
                                    } else if (plantResult.failed > 0) {
                                        console.log(`❌ Planting failed: ${plantResult.failed} beds failed, ${plantResult.rateLimited ? 'rate limited' : 'check API errors'}`);
                                        // If all failed, wait longer before retry to avoid hammering API
                                        await sleep(adaptiveWait([10000, 20000]));
                                    } else {
                                        console.log(`⚠️ No seeds planted - beds: ${emptyBedsCache.length}, seeds: ${cachedFarmSeeds.length}`);
                                    }
                                    // After planting, refresh garden data and recalculate growth
                                    await fetchFarmGardens(context, { minIntervalMs: 0, silent: true });
                                    if (lastGardensData) {
                                        const freshGrowth = analyzeVegetablePlotsGrowthState(lastGardensData, canHarvest);
                                        // Only shutdown if no empty beds remain AND next crop is far away
                                        if (freshGrowth.empty === 0 && freshGrowth.nextReadyAt && freshGrowth.nextReadyAt - Date.now() > 300000) {
                                            console.log(`⏹️ Planted all beds, next crop far away — shutting down`);
                                            await browser.close().catch(() => { });
                                            process.exit(0);
                                        }
                                        // If there are still empty beds, continue loop to plant more
                                        if (freshGrowth.empty > 0) {
                                            console.log(`⏳ Still have ${freshGrowth.empty} empty plot(s), continuing...`);
                                            continue;
                                        }
                                    }
                                } else {
                                    console.log(`⚠️ Have ${emptyBedsCache.length} empty beds but no seeds to plant`);
                                }
                            }
                        } else if (growth.ripe > 0 && !canHarvest) {
                            suffix = ` — ${growth.ripe} ripe but waiting sync`;
                            waitTime = adaptiveWait([3000, 5000]); // Check more frequently when ripe
                        }
                    }
                    aiLog("wait", { reason: "not_ready", seconds: Math.floor(waitTime / 1000) });
                    console.log(`Wait ${waitTime / 1000}s${suffix}`);
                    await sleep(waitTime);
                    continue;
                }

                if (canHarvest && !userFarmingID) {
                    console.log("⏳ Harvest flag set, waiting for userFarmingID from /api/farm (inventory has no farm id)…");
                    await fetchFarmGardens(context, { minIntervalMs: 0 });
                    const until = Date.now() + 45000;
                    while (Date.now() < until && !userFarmingID) await sleep(800);
                }

                if (!userFarmingID) {
                    console.log("⚠️ No userFarmingID — game has not returned farm state; backing off (avoid hammering inventory API)");
                    await fetchFarmGardens(context, { minIntervalMs: 0, silent: true });
                    canHarvest = false;
                    await sleep(adaptiveWait([15000, 30000]));
                    continue;
                }

                const since = Date.now() - lastHarvestAttemptAt;
                if (since < TIMING.minHarvestGap) await sleep(TIMING.minHarvestGap - since);

                console.log("🌾 HARVEST");
                aiLog("harvest_start", { farmingId: userFarmingID?.slice(0, 8), candidates: candidateFarmingIDs.length });
                lastHarvestAttemptAt = Date.now();

                let harvested = false;
                const harvestedBeds = [];
                const triedIds = new Set();
                const farmingIds = userFarmingID ? [userFarmingID] : [];
                for (const id of candidateFarmingIDs) {
                    if (typeof id === "string" && id.length > 4 && !triedIds.has(id)) {
                        triedIds.add(id);
                        farmingIds.push(id);
                    }
                }

                let apiRes = null;
                let sawNotReady = false;
                const harvestStart = Date.now();

                for (const farmingId of farmingIds) {
                    apiRes = await collectHarvestViaApi(context, farmingId);
                    if (apiRes.ok) {
                        userFarmingID = farmingId;
                        console.log("🌾 Harvest OK via API", apiRes.status, `(farm ${farmingId.slice(0, 8)}…)`);
                        if (apiRes.harvestData?.userBedsID) harvestedBeds.push(apiRes.harvestData.userBedsID);
                        if (apiRes.harvestData?.harvest?.length) {
                            const gains = apiRes.harvestData.harvest
                                .map((h) => `${h.code || h.type}×${h.count || 0}`)
                                .join(", ");
                            console.log("🎁 Harvest:", gains);
                        }
                        harvested = true;
                        break;
                    }
                    if (apiRes.status === 429) {
                        const waitSec = apiRes.retryAfter ?? rand(30, 60);
                        metrics.rateLimitsHit++;
                        console.log(`⚠️ Rate limited (429) — backing off ~${waitSec}s`);
                        canHarvest = false;
                        await sleep(waitSec * 1000);
                        continue;
                    }
                    if (isHarvestNotReadyError(apiRes.status, apiRes.text)) {
                        sawNotReady = true;
                        continue;
                    }
                    break;
                }

                if (!harvested && apiRes?.status === 429) continue;

                if (!harvested && sawNotReady) {
                    console.log("⏳ Harvest not ready yet — waiting for next farm state update");
                    canHarvest = false;
                    aiLog("harvest_not_ready", { ms: Date.now() - harvestStart });
                    await fetchFarmGardens(context, { minIntervalMs: 0, silent: true });
                    await sleep(adaptiveWait(TIMING.retryBackoff));
                    continue;
                }

                if (!harvested) {
                    if (apiRes?.reason) console.log("⚠️ API harvest skip:", apiRes.reason);
                    else if (apiRes) console.log("⚠️ API harvest failed", apiRes.status, apiRes.text?.slice(0, 200));

                    const pageRes = await collectHarvestViaPageFetch(page, userFarmingID);
                    if (pageRes.ok) {
                        console.log("🌾 Harvest OK via page fetch", pageRes.status);
                        harvested = true;
                    } else if (pageRes.status === 429) {
                        const waitSec = rand(30, 60);
                        metrics.rateLimitsHit++;
                        console.log(`⚠️ Page fetch rate limited (429) — backing off ~${waitSec}s`);
                        canHarvest = false;
                        await sleep(waitSec * 1000);
                        continue;
                    } else if (!pageRes.ok && pageRes.status !== 0) {
                        console.log("⚠️ Page fetch harvest failed", pageRes.status, pageRes.text?.slice(0, 200));
                    }
                    if (!harvested) harvested = await clickHarvest(page);
                }

                if (!harvested) {
                    console.log("⚠️ Harvest not done — retry later");
                    metrics.errors++;
                    updateSuccessRate(false);
                    canHarvest = false;
                    await sleep(adaptiveWait(TIMING.retryBackoff));
                    continue;
                }
                aiLog("harvest_done", { ms: Date.now() - harvestStart, beds: harvestedBeds.length });

                await sleep(adaptiveWait(TIMING.postHarvestWait));

                if (skipNextCycle) {
                    console.log("⏭️ SKIPPING planting as requested (harvest completed)");
                    skipNextCycle = false;
                    metrics.cyclesSkipped++;
                    canHarvest = false;
                    await sleep(adaptiveWait([5000, 10000]));
                    continue;
                }

                console.log("🌱 PLANTING");
                const plantStart = Date.now();
                aiLog("plant_start", { seeds: cachedFarmSeeds.reduce((s, x) => s + x.count, 0), emptyBeds: emptyBedsCache.length });

                await fetchFarmGardens(context, { minIntervalMs: 0, silent: true });
                await fetchFarmInventory(context, { minIntervalMs: 0, silent: true });

                const targetBeds = [];
                const seenBeds = new Set();
                for (const bedId of harvestedBeds) {
                    if (!seenBeds.has(bedId)) {
                        seenBeds.add(bedId);
                        targetBeds.push({ userBedsID: bedId, userGardensID: bedToGardenMap[bedId] });
                    }
                }
                for (const b of emptyBedsCache) {
                    if (!seenBeds.has(b.userBedsID)) {
                        seenBeds.add(b.userBedsID);
                        targetBeds.push(b);
                    }
                }

                let plantedViaApi = 0;
                if (cachedFarmSeeds.length && targetBeds.length) {
                    const batchResult = await batchPlantViaApi(context, targetBeds, cachedFarmSeeds);
                    plantedViaApi = batchResult.planted;
                    if (batchResult.rateLimited) {
                        const waitSec = batchResult.retryAfter ?? rand(20, 40);
                        metrics.rateLimitsHit++;
                        console.log(`⚠️ Plant batch rate limited — backing off ~${waitSec}s`);
                        await sleep(waitSec * 1000);
                    }
                }

                let plantedViaUi = 0;
                if (plantedViaApi === 0 && targetBeds.length > 0) {
                    const plots = await page.$$("canvas");
                    const plantBtn = page.getByRole("button", { name: /plant/i }).first();
                    for (const plot of plots.slice(0, Math.min(targetBeds.length, plots.length))) {
                        try {
                            await plot.click({ delay: rand(100, 300) });
                            await sleep(rand(300, 600));
                            if (await plantBtn.isVisible().catch(() => false)) {
                                await plantBtn.click({ timeout: 5000 });
                                plantedViaUi++;
                                metrics.plantsTotal++;
                                metrics.plantsUi++;
                                await sleep(rand(400, 800));
                            }
                        } catch { }
                    }
                }

                metrics.cyclesCompleted++;
                aiLog("plant_done", { api: plantedViaApi, ui: plantedViaUi, ms: Date.now() - plantStart, remainingSeeds: cachedFarmSeeds.reduce((s, x) => s + x.count, 0) });

                if (metrics.cyclesCompleted % 10 === 0) {
                    const m = logMetrics();
                    console.log(`📊 Stats: ${m.harvestsTotal} harvests, ${m.plantsTotal} plants, ${m.cyclesCompleted} cycles, uptime ${m.uptime}s`);
                }

                if (process.env.CHAINERS_SKIP_REWARD_POOL_DEPOSIT !== "1") {
                    console.log("🥕 Reward pool: depositing vegetables from storage…");
                    await depositStoredVegetablesToRewardPool(context);
                }

                console.log("🔄 DONE CYCLE");
                canHarvest = false;
                await saveStorageState(context);
                await sleep(adaptiveWait(TIMING.cycleEndWait));

            } catch (err) {
                console.log("💥 Restarting...", err.message);
                metrics.errors++;
                aiLog("error", { message: err?.message || String(err), phase: "main_loop" });
                await saveStorageState(context);
                await browser.close().catch(() => { });
                await sleep(5000);
                break;
            }
        }
    }
}

runBot().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
});