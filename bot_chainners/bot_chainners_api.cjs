#!/usr/bin/env node
/**
 * Chainers Farm Bot - API Only Version (No Browser)
 * Uses saved session from playwright_state.json for authentication
 */

const fs = require("fs");
const path = require("path");

// ================= CONFIG =================
const STORAGE_STATE_PATH = path.join(__dirname, "playwright_state.json");
const LOG_DIR = path.join(__dirname, "logs");
const AI_LOG_PATH = path.join(LOG_DIR, "ai_farm_api.log");

const API_BASE = "https://chainers.io/api";
const FARM_GARDENS_URL = `${API_BASE}/farm/user/gardens`;
const FARM_INVENTORY_URL = `${API_BASE}/farm/user/inventory?sort=lastUpdated&itemType=all&sortDirection=-1&skip=0&limit=0`;
const COLLECT_HARVEST_URL = `${API_BASE}/farm/control/collect-harvest`;
const PLANT_SEED_URL = `${API_BASE}/farm/control/plant-seed`;
const DAILY_REWARDS_URL = `${API_BASE}/main/daily-rewards/claim-current-day-reward`;
const WHEEL_STATE_URL = `${API_BASE}/main/fortune-games/user-game-state?code=wheel-of-fortune`;
const WHEEL_PLAY_URL = "https://proxy.chainers.io/fortune_games.FortuneGamesService/Play";
const REWARD_POOL_URL = `${API_BASE}/farm/reward-pools/add-vegetables-to-block`;
const REWARD_POOLS_STATE_URL = `${API_BASE}/farm/reward-pools/active-blocks-data`;

// Reward pool block ID from env or manual
const REWARD_POOL_BLOCK_ID = process.env.CHAINERS_REWARD_POOL_BLOCK_ID || "";
const DAILY_REWARD_EVENT_ID = process.env.CHAINERS_DAILY_REWARD_EVENT_ID || "69cbe94bf11d295b6fb7e651";

// Skip flags
const SKIP_DAILY = process.env.CHAINERS_SKIP_DAILY_REWARD === "1";
const SKIP_WHEEL = process.env.CHAINERS_SKIP_WHEEL_OF_FORTUNE === "1";
const SKIP_POOL = process.env.CHAINERS_SKIP_REWARD_POOL_DEPOSIT === "1";

// ================= UTILS =================
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function now() {
    return new Date().toISOString();
}

function log(...args) {
    console.log(`[${now().split("T")[1].slice(0, 8)}]`, ...args);
}

function aiLog(event, data) {
    const entry = { t: now(), event, ...data };
    const line = JSON.stringify(entry);
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.appendFileSync(AI_LOG_PATH, line + "\n");
    } catch { }
    console.log("📊", event, data);
}

function tryParseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function isVegetableItem(item) {
    if (!item?.itemCode || item.count <= 0) return false;
    if (item.itemType === "farmSeeds") return false;
    if (String(item.itemCode).endsWith("_seeds")) return false;
    if (String(item.itemCode).endsWith("_food")) return false;

    // Check itemType first
    const t = String(item.itemType || "").toLowerCase();
    if (t === "farmvegetables" || t === "vegetables" || t.includes("vegetable")) {
        return true;
    }

    // Accept produce by rarity pattern (common, uncommon, rare, legendary)
    const code = String(item.itemCode).toLowerCase();
    if (code.match(/^(common|uncommon|rare|legendary)_/) && !code.includes("_seeds")) {
        return true;
    }

    return false;
}

// ================= SESSION =================
class ApiSession {
    constructor() {
        this.cookies = [];
        this.headers = {
            "accept": "application/json",
            "accept-language": "en-US,en;q=0.9",
            "content-type": "application/json",
            "origin": "https://chainers.io",
            "referer": "https://chainers.io/",
            "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
        };
        this.lastAuthHeader = null;
    }

    loadFromStorageState() {
        if (!fs.existsSync(STORAGE_STATE_PATH)) {
            throw new Error("No saved session. Run browser version first to login.");
        }

        const state = JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, "utf8"));

        // Extract cookies
        if (state.cookies) {
            this.cookies = state.cookies.filter(c =>
                c.domain.includes("chainers.io")
            );
        }

        // Extract auth token from origins if available
        if (state.origins) {
            for (const origin of state.origins) {
                if (origin.origin.includes("chainers.io")) {
                    for (const item of origin.localStorage || []) {
                        if (item.name?.toLowerCase().includes("token") ||
                            item.name?.toLowerCase().includes("auth")) {
                            this.lastAuthHeader = item.value;
                        }
                    }
                }
            }
        }

        // Build cookie header
        const cookieStr = this.cookies.map(c => `${c.name}=${c.value}`).join("; ");
        if (cookieStr) {
            this.headers["cookie"] = cookieStr;
        }

        log("📦 Session loaded:", this.cookies.length, "cookies");
        return true;
    }

    getHeaders(withAuth = false) {
        const h = { ...this.headers };
        if (withAuth && this.lastAuthHeader) {
            h["authorization"] = this.lastAuthHeader.startsWith("Bearer ")
                ? this.lastAuthHeader
                : `Bearer ${this.lastAuthHeader}`;
        }
        return h;
    }

    async request(method, url, { body = null, withAuth = true } = {}) {
        const https = require("https");
        const http = require("http");
        const { URL } = require("url");

        const parsed = new URL(url);
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: method.toUpperCase(),
            headers: this.getHeaders(withAuth),
            timeout: 30000
        };

        return new Promise((resolve, reject) => {
            const lib = parsed.protocol === "https:" ? https : http;
            const req = lib.request(options, (res) => {
                let data = "";
                res.on("data", chunk => data += chunk);
                res.on("end", () => {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        text: () => Promise.resolve(data),
                        json: () => Promise.resolve(tryParseJson(data)),
                        ok: () => res.statusCode >= 200 && res.statusCode < 300
                    });
                });
            });

            req.on("error", reject);
            req.on("timeout", () => {
                req.destroy();
                reject(new Error("Request timeout"));
            });

            if (body) {
                req.write(typeof body === "string" ? body : JSON.stringify(body));
            }
            req.end();
        });
    }

    async get(url, opts = {}) {
        return this.request("GET", url, opts);
    }

    async post(url, opts = {}) {
        return this.request("POST", url, opts);
    }
}

// ================= FARM STATE =================
class FarmBot {
    constructor() {
        this.session = new ApiSession();
        this.userFarmingID = null;
        this.canHarvest = false;
        this.gardensData = null;
        this.inventory = null;
        this.emptyBeds = [];
        this.seeds = [];
        this.vegetables = [];
    }

    async init() {
        this.session.loadFromStorageState();
        await this.fetchGardens();
        await this.fetchInventory();
        log("🌾 Bot initialized - Farming ID:", this.userFarmingID?.slice(0, 8));
    }

    async fetchGardens() {
        const res = await this.session.get(FARM_GARDENS_URL);
        const data = await res.json();

        if (data?.success) {
            this.gardensData = data;
            this.processGardens(data);
            aiLog("gardens_fetched", {
                gardens: data.data?.length || 0,
                canHarvest: this.canHarvest,
                emptyBeds: this.emptyBeds.length
            });
        }
        return data;
    }

    async fetchInventory() {
        const res = await this.session.get(FARM_INVENTORY_URL);
        const data = await res.json();

        if (data?.success) {
            this.inventory = data;
            this.processInventory(data);
            aiLog("inventory_fetched", {
                seeds: this.seeds.length,
                vegetables: this.vegetables.length
            });
        }
        return data;
    }

    processGardens(data) {
        this.emptyBeds = [];
        this.canHarvest = false;

        for (const garden of data.data || []) {
            // Find farming ID
            if (garden.userFarmingID) {
                this.userFarmingID = garden.userFarmingID;
            }

            // Check garden-level harvest flag
            if (garden.isCollectHarvestAvailable) {
                this.canHarvest = true;
            }

            // Process beds
            for (const bed of garden.placedBeds || []) {
                if (!bed.plantedSeed) {
                    this.emptyBeds.push({
                        userGardensID: garden.id || garden._id,
                        userBedsID: bed.userBedsID,
                        gardenIndex: garden.gardenIndex
                    });
                } else if (bed.plantedSeed.isCollectHarvestAvailable) {
                    this.canHarvest = true;
                }
            }
        }
    }

    processInventory(data) {
        this.seeds = [];
        this.vegetables = [];

        for (const item of data.data?.items || data.data || []) {
            if (item.itemType === "farmSeeds" && item.count > 0) {
                this.seeds.push({
                    itemID: item.itemID || item.id || item._id,
                    itemCode: item.itemCode,
                    count: item.count
                });
            } else if (isVegetableItem(item)) {
                this.vegetables.push({
                    itemCode: item.itemCode,
                    count: item.count
                });
            }
        }
    }

    async collectHarvest() {
        if (!this.userFarmingID) {
            log("⚠️ No farming ID");
            return { ok: false };
        }

        log("🌾 Collecting harvest...");
        const res = await this.session.post(COLLECT_HARVEST_URL, {
            body: { userFarmingID: this.userFarmingID }
        });

        const data = await res.json();
        const ok = res.ok() && data?.success;

        if (ok) {
            const items = data.data?.collectedItems || [];
            log("✅ Harvest collected:", items.map(i => `${i.count}x ${i.code}`).join(", ") || "success");
            aiLog("harvest", { ok: true, items: items.length });
            this.canHarvest = false;
        } else {
            log("⚠️ Harvest failed:", data?.error || res.status);
            aiLog("harvest", { ok: false, status: res.status, error: data?.error });
        }

        return { ok, data };
    }

    async plantAll() {
        if (!this.emptyBeds.length || !this.seeds.length) {
            log("ℹ️ No empty beds or seeds");
            return { planted: 0 };
        }

        log("🌱 Planting", Math.min(this.emptyBeds.length, this.seeds.reduce((s, x) => s + x.count, 0)), "seeds...");
        aiLog("plant_start", { emptyBeds: this.emptyBeds.length, seeds: this.seeds.length });

        let planted = 0;
        const seedQueue = [...this.seeds];

        for (const bed of this.emptyBeds) {
            const seed = seedQueue.find(s => s.count > 0);
            if (!seed) break;

            const res = await this.session.post(PLANT_SEED_URL, {
                body: {
                    userGardensID: bed.userGardensID,
                    userBedsID: bed.userBedsID,
                    seedID: seed.itemID
                }
            });

            if (res.ok()) {
                seed.count--;
                planted++;
                await sleep(rand(500, 1000));
            } else if (res.status === 429) {
                log("⚠️ Rate limited, waiting...");
                await sleep(5000);
            }
        }

        log("✅ Planted", planted, "seeds");
        aiLog("plant_done", { planted });
        return { planted };
    }

    async claimDailyReward() {
        if (SKIP_DAILY) return;

        log("🎁 Claiming daily reward...");
        const res = await this.session.post(DAILY_REWARDS_URL, {
            body: { dailyRewardsEventsID: DAILY_REWARD_EVENT_ID }
        });

        const data = await res.json();
        if (res.ok() && data?.success) {
            const cards = data.data?.boosterReceivedCards || [];
            log("✅ Daily reward:", cards.map(c => `${c.rarity}×${c.count}`).join(", ") || "claimed");
            aiLog("daily_reward", { ok: true, items: cards.length });
        } else if (data?.error?.includes("already claimed")) {
            log("ℹ️ Daily reward already claimed");
        } else {
            log("⚠️ Daily reward failed:", data?.error);
        }
    }

    async playWheelOfFortune() {
        if (SKIP_WHEEL) return;

        // Get available bids
        const stateRes = await this.session.get(WHEEL_STATE_URL);
        const state = await stateRes.json();

        if (!state?.success) {
            log("⚠️ Could not get wheel state");
            return;
        }

        const bids = state.data?.availableFortuneGamesBids || [];
        if (!bids.length) {
            log("ℹ️ No wheel spins available");
            return;
        }

        log("🎰 Wheel of Fortune:", bids.length, "spins");
        aiLog("wheel_start", { spins: bids.length });

        for (const bid of bids) {
            // Encode protobuf-style payload
            const encodeBid = (id) => {
                const bytes = Buffer.from(id, "utf8");
                const len = bytes.length;
                const buf = Buffer.alloc(1 + len);
                buf[0] = len;
                bytes.copy(buf, 1);
                return buf;
            };
            const bidBytes = encodeBid(bid.id);
            const wrapper = Buffer.concat([Buffer.from([0x0a]), bidBytes]);
            const base64 = wrapper.toString("base64");

            const res = await this.session.post(WHEEL_PLAY_URL, {
                body: base64,
                withAuth: true
            });

            if (res.ok()) {
                log("🎰 Spin played:", bid.id.slice(0, 8));
                aiLog("wheel_spin", { ok: true });
            } else {
                log("⚠️ Spin failed:", res.status);
            }

            await sleep(rand(1000, 2000));
        }
    }

    async fetchRewardPoolBlockId() {
        try {
            const res = await this.session.get(REWARD_POOLS_STATE_URL);
            const data = await res.json();
            if (data?.success && Array.isArray(data?.data)) {
                // Find IBNB block from active blocks list
                const ibnbBlock = data.data.find(b => b.currency === "IBNB" || b.rewardPoolCode?.includes("BNB"));
                if (ibnbBlock?.id) {
                    log("📦 Fetched IBNB reward pool block:", ibnbBlock.id.slice(0, 8) + "…", "(" + ibnbBlock.currency + ")");
                    return ibnbBlock.id;
                }
            }
        } catch (e) {
            // Silent fail
        }
        return null;
    }

    async depositToRewardPool() {
        if (SKIP_POOL) return;

        if (!this.vegetables.length) {
            log("ℹ️ No vegetables to deposit");
            return;
        }

        // Try to get block ID from env or fetch from API
        let blockId = REWARD_POOL_BLOCK_ID;
        if (!blockId) {
            blockId = await this.fetchRewardPoolBlockId();
        }

        if (!blockId) {
            log("ℹ️ No reward pool block ID available. Set CHAINERS_REWARD_POOL_BLOCK_ID or let bot auto-fetch.");
            return;
        }

        log("🥕 Depositing", this.vegetables.length, "vegetable types to reward pool (block", blockId.slice(0, 8) + "…)…");
        aiLog("pool_start", { vegetables: this.vegetables.length });

        const chunkSize = 40;
        let totalDeposited = 0;

        for (let i = 0; i < this.vegetables.length; i += chunkSize) {
            const chunk = this.vegetables.slice(i, i + chunkSize);

            const res = await this.session.post(REWARD_POOL_URL, {
                body: {
                    rewardsPoolsBlocksID: blockId,
                    vegetables: chunk.map(v => ({ itemCode: v.itemCode, count: v.count }))
                }
            });

            const data = await res.json();

            if (res.ok() && data?.success) {
                totalDeposited += chunk.reduce((s, v) => s + v.count, 0);
                log("✅ Pool deposit:", chunk.map(v => `${v.count}x ${v.itemCode}`).join(", ").slice(0, 80));
                aiLog("pool_deposit", { ok: true, items: chunk.length });
            } else if (data?.error?.includes("not found")) {
                log("⚠️ Pool block not found (expired). Will try to fetch new block on next cycle.");
                aiLog("pool_deposit", { ok: false, error: "block_not_found" });
                break;
            } else if (data?.error?.includes("already")) {
                log("ℹ️ Already deposited");
                break;
            } else if (res.status === 429) {
                log("⚠️ Pool rate limited");
                await sleep(30000);
                break;
            } else {
                log("⚠️ Pool deposit failed:", data?.error || res.status);
                aiLog("pool_deposit", { ok: false, error: data?.error });
                break;
            }

            await sleep(rand(500, 1000));
        }

        log("✅ Total deposited:", totalDeposited);
    }

    async getNextHarvestTime() {
        let nextTime = null;

        for (const garden of this.gardensData?.data || []) {
            for (const bed of garden.placedBeds || []) {
                if (bed.plantedSeed?.dateGrowth) {
                    const growthTime = new Date(bed.plantedSeed.dateGrowth).getTime();
                    if (growthTime > Date.now() && (!nextTime || growthTime < nextTime)) {
                        nextTime = growthTime;
                    }
                }
            }
        }

        return nextTime;
    }

    async runCycle() {
        await this.fetchGardens();
        await this.fetchInventory();

        // Harvest if ready
        if (this.canHarvest) {
            await this.collectHarvest();
            await this.fetchGardens(); // Refresh after harvest
        }

        // Plant if we have empty beds and seeds
        if (this.emptyBeds.length && this.seeds.length) {
            await this.plantAll();
        }

        // Deposit vegetables to reward pool
        await this.depositToRewardPool();

        // Check next harvest time
        const nextHarvest = await this.getNextHarvestTime();
        if (nextHarvest) {
            const msLeft = nextHarvest - Date.now();
            const minutes = Math.floor(msLeft / 60000);

            if (msLeft > 5 * 60 * 1000) {
                log("⏹️ Next harvest in", minutes, "min - exiting");
                aiLog("exit_long_wait", { minutes });
                process.exit(0);
            }

            log("⏳ Next harvest in", minutes, "min");
            return msLeft;
        }

        return 30000; // Default 30s wait
    }

    async run() {
        log("🚀 API BOT START");

        try {
            await this.init();
        } catch (e) {
            log("💥 Failed to init:", e.message);
            log("👉 Run browser version first to create session");
            process.exit(1);
        }

        // One-time bonuses
        await this.claimDailyReward();
        await this.playWheelOfFortune();

        // Main loop
        while (true) {
            try {
                const waitMs = await this.runCycle();
                await sleep(Math.max(5000, waitMs - 5000)); // Wake up 5s before ready
            } catch (e) {
                log("💥 Cycle error:", e.message);
                await sleep(30000);
            }
        }
    }
}

// ================= MAIN =================
const bot = new FarmBot();
bot.run().catch(e => {
    console.error("Fatal:", e);
    process.exit(1);
});
