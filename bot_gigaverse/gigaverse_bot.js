import axios from "axios"
import dotenv from "dotenv"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

dotenv.config()

const TOKEN = process.env.TOKEN

const API = "https://gigaverse.io/api/game/dungeon/action"

let headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
    origin: "https://gigaverse.io",
    referer: "https://gigaverse.io/play"
}

let actionToken = ""
let dungeonId = 1
let run = null
let events = null

// ================= AI LOGGING =================
const LOGS_DIR = path.join(__dirname, "logs")
const AI_LOG_FILE = path.join(LOGS_DIR, "gigaverse_farm.log")
const PERF_LOG_FILE = path.join(LOGS_DIR, "performance.log")

function ensureLogsDir() {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true })
}
ensureLogsDir()

function aiLog(type, data) {
    const entry = {
        ts: new Date().toISOString(),
        type,
        data
    }
    try {
        fs.appendFileSync(AI_LOG_FILE, JSON.stringify(entry) + "\n")
    } catch { }
}

function perfLog(operation, durationMs, success, extra = {}) {
    const entry = {
        ts: new Date().toISOString(),
        op: operation,
        ms: durationMs,
        ok: success,
        ...extra
    }
    try {
        fs.appendFileSync(PERF_LOG_FILE, JSON.stringify(entry) + "\n")
    } catch { }
}

/** Adaptive timing based on success rate */
let recentSuccessRate = 1.0
function updateSuccessRate(success) {
    recentSuccessRate = recentSuccessRate * 0.8 + (success ? 1 : 0) * 0.2
}
function adaptiveDelay(baseMin, baseMax) {
    const factor = 1 + (1 - recentSuccessRate) * 0.5
    return Math.floor(Math.random() * (baseMax * factor - baseMin * factor) + baseMin * factor)
}

const HISTORY_FILE = "./bot_history.json"

const AI_MEMORY = {
    build: "balanced",
    lastResult: null,
    history: [],
    enemyHistory: [],
    myMoveHistory: [],
    methodPerformance: {
        pattern: { win: 0, loss: 0 },
        markov2: { win: 0, loss: 0 },
        markov1: { win: 0, loss: 0 },
        ngram: { win: 0, loss: 0 },
        streak: { win: 0, loss: 0 },
        frequency: { win: 0, loss: 0 },
        exploitative: { win: 0, loss: 0 },
        random: { win: 0, loss: 0 },
        doublethink: { win: 0, loss: 0 },
        mirror: { win: 0, loss: 0 },
        antimirror: { win: 0, loss: 0 },
        counterrot: { win: 0, loss: 0 },
        bayesian: { win: 0, loss: 0 },
        transition: { win: 0, loss: 0 }
    },
    lastMethod: null,
    consecutiveLosses: 0,
    winStreak: 0,
    patternConfidence: 0,
    dynamicThreshold: 0.5,
    lastOutcomeWasLoss: false,
    enemyResponseToLoss: [],
    enemyResponseToWin: [],
    isEnemyMirroring: false,
    mirrorConfidence: 0,
    bayesianStats: {
        rock: { alpha: 1, beta: 1 },
        paper: { alpha: 1, beta: 1 },
        scissor: { alpha: 1, beta: 1 }
    },
    // Extended tracking for optimization
    sessionStats: {
        totalSessions: 0,
        totalGames: 0,
        totalWins: 0,
        totalLosses: 0,
        bestWinStreak: 0,
        worstLossStreak: 0
    },
    enemyPatterns: {},
    dungeonStats: {},
    moveDetails: [],
    chargeEfficiency: {
        rock: { used: 0, won: 0 },
        paper: { used: 0, won: 0 },
        scissor: { used: 0, won: 0 }
    },
    roomPerformance: {},
    timePatterns: {},
    buildPerformance: {
        balanced: { win: 0, loss: 0, total: 0 },
        rock: { win: 0, loss: 0, total: 0 },
        paper: { win: 0, loss: 0, total: 0 },
        scissor: { win: 0, loss: 0, total: 0 }
    }
}

const STATS = {
    win: 0,
    lose: 0,
    total: 0,
    draws: 0
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
}

function randomDelay() {
    return Math.floor(Math.random() * 5000) + 3000
}

function getWinRate() {
    const { win, lose } = STATS
    const total = win + lose
    if (total === 0) return 0
    return ((win / total) * 100).toFixed(2)
}

function getRecentWinRate(n = 20) {
    const recent = AI_MEMORY.history.slice(-n)
    const wins = recent.filter(r => r === "win").length
    const total = recent.filter(r => r === "win" || r === "lose").length
    return total === 0 ? 0 : ((wins / total) * 100).toFixed(2)
}

function getBestMethod() {
    const methods = Object.entries(AI_MEMORY.methodPerformance)
    const scored = methods.map(([name, perf]) => {
        const total = perf.win + perf.loss
        const rate = total === 0 ? 0 : perf.win / total
        return { name, rate, total, score: rate * Math.min(total, 10) }
    })
    return scored.sort((a, b) => b.score - a.score)[0]?.name || "random"
}

function updateMethodPerformance(result) {
    if (!AI_MEMORY.lastMethod) return
    const method = AI_MEMORY.lastMethod
    if (result === "win") {
        AI_MEMORY.methodPerformance[method].win++
        AI_MEMORY.winStreak++
        AI_MEMORY.consecutiveLosses = 0
        AI_MEMORY.sessionStats.bestWinStreak = Math.max(AI_MEMORY.sessionStats.bestWinStreak, AI_MEMORY.winStreak)
    } else if (result === "lose") {
        AI_MEMORY.methodPerformance[method].loss++
        AI_MEMORY.consecutiveLosses++
        AI_MEMORY.winStreak = 0
        AI_MEMORY.sessionStats.worstLossStreak = Math.max(AI_MEMORY.sessionStats.worstLossStreak, AI_MEMORY.consecutiveLosses)
    }
}

// ===== HISTORY PERSISTENCE =====
function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))

            // Handle both old (verbose) and new (compact) formats
            AI_MEMORY.sessionStats = data.ss || data.sessionStats || AI_MEMORY.sessionStats
            AI_MEMORY.methodPerformance = data.mp || data.methodPerformance || AI_MEMORY.methodPerformance
            AI_MEMORY.enemyPatterns = data.ep || data.enemyPatterns || {}
            AI_MEMORY.dungeonStats = data.ds || data.dungeonStats || {}
            AI_MEMORY.chargeEfficiency = data.ce || data.chargeEfficiency || AI_MEMORY.chargeEfficiency
            AI_MEMORY.roomPerformance = data.rp || data.roomPerformance || {}
            AI_MEMORY.buildPerformance = data.bp || data.buildPerformance || AI_MEMORY.buildPerformance
            AI_MEMORY.history = data.h || data.history || []
            AI_MEMORY.enemyHistory = data.eh || data.enemyHistory || []
            AI_MEMORY.myMoveHistory = data.mm || data.myMoveHistory || []

            // Handle compact moveDetails format
            const compactMd = data.md || data.moveDetails || []
            AI_MEMORY.moveDetails = compactMd.map(r => ({
                timestamp: r.t || r.timestamp,
                move: r.m || r.move,
                enemyMove: r.e || r.enemyMove,
                result: r.r || r.result,
                build: r.b || r.build,
                room: r.n || r.room,
                method: r.x || r.method
            }))

            const totalStats = data.ts || data.totalStats || {}
            STATS.win = totalStats.win || 0
            STATS.lose = totalStats.lose || 0
            STATS.total = totalStats.total || 0
            STATS.draws = totalStats.draws || 0
            AI_MEMORY.sessionStats.totalSessions++
            console.log(`Loaded history: ${AI_MEMORY.moveDetails.length} games, ${AI_MEMORY.sessionStats.totalWins} wins, ${AI_MEMORY.sessionStats.totalLosses} losses`)
            console.log(`Overall winrate: ${getGlobalWinrate()}%`)
            console.log(`Best win streak: ${AI_MEMORY.sessionStats.bestWinStreak}, Worst loss streak: ${AI_MEMORY.sessionStats.worstLossStreak}`)
        }
    } catch (err) {
        console.log("Failed to load history:", err.message)
    }
}

function saveHistory() {
    try {
        // Limit memory arrays
        if (AI_MEMORY.moveDetails.length > 200) AI_MEMORY.moveDetails = AI_MEMORY.moveDetails.slice(-100)

        // Convert to ultra-compact format for file storage
        const compactDetails = AI_MEMORY.moveDetails.map(r => ({
            t: r.timestamp,
            m: r.move,
            e: r.enemyMove,
            r: r.result,
            b: r.build,
            n: r.room,
            x: r.method
        }))

        const data = {
            ss: AI_MEMORY.sessionStats,
            mp: AI_MEMORY.methodPerformance,
            ep: AI_MEMORY.enemyPatterns,
            ds: AI_MEMORY.dungeonStats,
            ce: AI_MEMORY.chargeEfficiency,
            rp: AI_MEMORY.roomPerformance,
            bp: AI_MEMORY.buildPerformance,
            h: AI_MEMORY.history.slice(-50),
            eh: AI_MEMORY.enemyHistory.slice(-50),
            mm: AI_MEMORY.myMoveHistory.slice(-50),
            md: compactDetails.slice(-100),
            ts: STATS,
            ls: Date.now()
        }
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(data))
    } catch (err) {
        console.log("Failed to save history:", err.message)
    }
}

function recordDetailedGame(move, enemyMove, result, method) {
    const room = run?.currentRoom || 0

    // Store lightweight record in memory (compact format)
    AI_MEMORY.moveDetails.push({
        timestamp: Date.now(),
        move,
        enemyMove,
        result,
        method,
        build: AI_MEMORY.build,
        room
    })
    AI_MEMORY.sessionStats.totalGames++
    if (result === 'win') AI_MEMORY.sessionStats.totalWins++
    if (result === 'lose') AI_MEMORY.sessionStats.totalLosses++

    // Track charge efficiency
    AI_MEMORY.chargeEfficiency[move].used++
    if (result === 'win') AI_MEMORY.chargeEfficiency[move].won++

    // Track room performance
    const roomKey = `room_${room}`
    if (!AI_MEMORY.roomPerformance[roomKey]) {
        AI_MEMORY.roomPerformance[roomKey] = { win: 0, loss: 0, total: 0 }
    }
    AI_MEMORY.roomPerformance[roomKey].total++
    if (result === 'win') AI_MEMORY.roomPerformance[roomKey].win++
    if (result === 'lose') AI_MEMORY.roomPerformance[roomKey].loss++

    // Track dungeon performance
    const dungeonType = run?.dungeon?.type || 'unknown'
    if (!AI_MEMORY.dungeonStats[dungeonType]) {
        AI_MEMORY.dungeonStats[dungeonType] = { win: 0, loss: 0, total: 0 }
    }
    AI_MEMORY.dungeonStats[dungeonType].total++
    if (result === 'win') AI_MEMORY.dungeonStats[dungeonType].win++
    if (result === 'lose') AI_MEMORY.dungeonStats[dungeonType].loss++

    // Track build performance
    AI_MEMORY.buildPerformance[AI_MEMORY.build].total++
    if (result === 'win') AI_MEMORY.buildPerformance[AI_MEMORY.build].win++
    if (result === 'lose') AI_MEMORY.buildPerformance[AI_MEMORY.build].loss++

    // Save after every game
    saveHistory()
}

function getGlobalWinrate() {
    const { totalWins, totalLosses } = AI_MEMORY.sessionStats
    const total = totalWins + totalLosses
    return total === 0 ? 0 : ((totalWins / total) * 100).toFixed(2)
}

function getBuildWinrate(build) {
    const perf = AI_MEMORY.buildPerformance[build]
    if (!perf || perf.total === 0) return 0
    return ((perf.win / perf.total) * 100).toFixed(2)
}

function getChargeWinrate(move) {
    const eff = AI_MEMORY.chargeEfficiency[move]
    if (!eff || eff.used === 0) return 0
    return ((eff.won / eff.used) * 100).toFixed(2)
}

function getBestBuild() {
    const builds = Object.entries(AI_MEMORY.buildPerformance)
    const valid = builds.filter(([, p]) => p.total > 0)
    if (valid.length === 0) return 'balanced'
    return valid.sort(([, a], [, b]) => (b.win / b.total) - (a.win / a.total))[0][0]
}

function getWave(room) {

    const wave = Math.floor((room - 1) / 4) + 1
    const waveRoom = ((room - 1) % 4) + 1

    return `${wave}-${waveRoom}`

}

function counter(move) {

    if (move === "rock") return "paper"
    if (move === "paper") return "scissor"
    if (move === "scissor") return "rock"

    return null
}

function chooseMove(run) {
    const player = run.players[0]
    const rock = player.rock?.currentCharges ?? 0
    const paper = player.paper?.currentCharges ?? 0
    const scissor = player.scissor?.currentCharges ?? 0

    const available = []
    if (rock > 0) available.push("rock")
    if (paper > 0) available.push("paper")
    if (scissor > 0) available.push("scissor")

    if (available.length === 0) return null
    if (available.length === 1) return available[0]

    const predictions = []
    const threshold = getDynamicThreshold()
    const entropy = calculateEntropy()

    // PRIORITY 1: MIRROR STRATEGIES (high confidence when detected)
    const mirrorPred = detectMirror()
    if (mirrorPred && AI_MEMORY.mirrorConfidence >= 0.75) {
        const c = counter(mirrorPred)
        if (available.includes(c)) {
            predictions.push({ method: "antimirror", move: c, confidence: 0.9 * AI_MEMORY.mirrorConfidence, pred: mirrorPred })
        }
    }

    // PRIORITY 2: N-GRAM PATTERN (length 2-5) - highest base confidence
    for (let len = 6; len >= 2; len--) {
        const pred = predictByNgram(len)
        if (pred) {
            const c = counter(pred)
            if (available.includes(c)) {
                // Higher confidence for longer patterns
                predictions.push({ method: "ngram", move: c, confidence: 0.75 + len * 0.04, pred })
            }
        }
    }

    // PRIORITY 3: STREAK DETECTION (exploits repetition bias)
    const streakPred = detectStreak()
    if (streakPred) {
        const c = counter(streakPred)
        if (available.includes(c)) {
            predictions.push({ method: "streak", move: c, confidence: 0.88, pred: streakPred })
        }
    }

    // PRIORITY 4: ROTATION DETECTION (rock→paper→scissor cycle)
    const rotation = detectRotation()
    if (rotation) {
        const c = counter(rotation)
        if (available.includes(c)) {
            predictions.push({ method: "pattern", move: c, confidence: 0.82, pred: rotation })
        }
    }

    // PRIORITY 4b: ALTERNATING PATTERN (A-B-A-B)
    const alternating = detectAlternating()
    if (alternating) {
        const c = counter(alternating)
        if (available.includes(c)) {
            predictions.push({ method: "pattern", move: c, confidence: 0.8, pred: alternating })
        }
    }

    // PRIORITY 5: COUNTER-ROTATION (opponent trying to counter us)
    const counterRot = detectCounterRotation()
    if (counterRot) {
        const c = counter(counterRot)
        if (available.includes(c)) {
            predictions.push({ method: "counterrot", move: c, confidence: 0.78, pred: counterRot })
        }
    }

    // PRIORITY 6: 2ND-ORDER MARKOV (context: last 2 moves)
    const markov2 = predictMarkovOrder(2)
    if (markov2) {
        const c = counter(markov2)
        if (available.includes(c)) {
            predictions.push({ method: "markov2", move: c, confidence: 0.72, pred: markov2 })
        }
    }

    // PRIORITY 7: TRANSITION PATTERN (how opponent responds to win/loss)
    const transition = predictTransition()
    if (transition) {
        const c = counter(transition)
        if (available.includes(c)) {
            predictions.push({ method: "transition", move: c, confidence: 0.68, pred: transition })
        }
    }

    // PRIORITY 8: DOUBLE-THINK (level 2 reasoning)
    const doubleThink = predictDoubleThink()
    if (doubleThink) {
        const c = counter(doubleThink)
        if (available.includes(c)) {
            predictions.push({ method: "doublethink", move: c, confidence: 0.7, pred: doubleThink })
        }
    }

    // PRIORITY 8b: LEVEL-3 THINKING (for advanced opponents)
    const level3 = predictLevel3()
    if (level3) {
        const c = counter(level3)
        if (available.includes(c)) {
            predictions.push({ method: "doublethink", move: c, confidence: 0.6, pred: level3 })
        }
    }

    // PRIORITY 9: BAYESIAN PREDICTION
    const bayesian = predictBayesian()
    if (bayesian) {
        const c = counter(bayesian)
        if (available.includes(c)) {
            predictions.push({ method: "bayesian", move: c, confidence: 0.62, pred: bayesian })
        }
    }

    // PRIORITY 10: 1ST-ORDER MARKOV
    const markov1 = predictMarkovOrder(1)
    if (markov1) {
        const c = counter(markov1)
        if (available.includes(c)) {
            predictions.push({ method: "markov1", move: c, confidence: 0.6, pred: markov1 })
        }
    }

    // PRIORITY 11: EXPLOITATIVE
    const exploitative = predictExploitative()
    if (exploitative) {
        const c = counter(exploitative)
        if (available.includes(c)) {
            predictions.push({ method: "exploitative", move: c, confidence: 0.58, pred: exploitative })
        }
    }

    // PRIORITY 11b: RESPONSE TO OUR MOVES
    const responsePattern = predictResponseToOurMoves()
    if (responsePattern) {
        const c = counter(responsePattern)
        if (available.includes(c)) {
            predictions.push({ method: "pattern", move: c, confidence: 0.6, pred: responsePattern })
        }
    }

    // PRIORITY 12: FREQUENCY
    const freq = predictByFrequencyExp()
    if (freq) {
        const c = counter(freq)
        if (available.includes(c)) {
            predictions.push({ method: "frequency", move: c, confidence: 0.55, pred: freq })
        }
    }

    // NEW: CHARGE EXPLOITATION - Detect when enemy is forced into moves
    const chargeExploit = predictByChargeDepletion(run)
    if (chargeExploit) {
        const c = counter(chargeExploit)
        if (available.includes(c)) {
            predictions.push({ method: "exploitative", move: c, confidence: 0.85, pred: chargeExploit })
        }
    }

    // Select best prediction using performance-weighted voting with recency bias
    if (predictions.length > 0) {
        const scored = predictions.map(p => {
            const perf = AI_MEMORY.methodPerformance[p.method]
            const totalGames = perf.win + perf.loss

            // Base performance rate with beta prior (Laplace smoothing)
            const perfRate = totalGames === 0 ? 0.5 : (perf.win + 1) / (totalGames + 2)

            // Weight by number of samples (diminishing returns after 15 games)
            const sampleWeight = Math.min(totalGames / 15, 1)

            // Recency bonus: boost methods that have performed well recently
            const recencyBonus = (perf.win > perf.loss && totalGames > 3) ? 0.08 : 0

            // Entropy adjustment: boost confidence for predictable opponents
            const entropyBoost = entropy < 0.4 ? 0.12 : entropy < 0.6 ? 0.06 : 0

            // Streak bonus: boost confidence when on a win streak with this method
            const streakBonus = (AI_MEMORY.winStreak >= 2 && perf.win > perf.loss) ? 0.05 : 0

            const adjustedConfidence = p.confidence * (0.5 + 0.5 * perfRate * sampleWeight) + recencyBonus + entropyBoost + streakBonus

            return { ...p, score: adjustedConfidence }
        })

        scored.sort((a, b) => b.score - a.score)
        const best = scored[0]

        // Check for method consensus (multiple methods agreeing)
        const moveCounts = {}
        scored.forEach(p => {
            moveCounts[p.move] = (moveCounts[p.move] || 0) + p.score
        })

        const sortedMoves = Object.entries(moveCounts)
            .sort(([, a], [, b]) => b - a)

        const consensusMove = sortedMoves[0]
        const secondBest = sortedMoves[1]

        // Stronger consensus: requires 65% agreement AND clear margin over second best
        const totalScore = scored.reduce((sum, p) => sum + p.score, 0)
        const hasConsensus = consensusMove &&
            (moveCounts[consensusMove[0]] / totalScore) > 0.65 &&
            (!secondBest || moveCounts[consensusMove[0]] > moveCounts[secondBest[0]] * 1.3)

        // Use consensus move if strong agreement
        const finalMove = hasConsensus ? consensusMove[0] : best.move
        const finalScore = hasConsensus ? Math.max(best.score, 0.8) : best.score

        // Only play if confidence meets dynamic threshold
        if (finalScore > threshold) {
            AI_MEMORY.lastMethod = best.method
            AI_MEMORY.patternConfidence = finalScore
            const consensusTag = hasConsensus ? " [CONSENSUS]" : ""
            console.log(`AI ${best.method.toUpperCase()}${consensusTag} → counter ${best.pred} (conf: ${finalScore.toFixed(2)}, thresh: ${threshold.toFixed(2)})`)
            return finalMove
        }
    }

    // SMART FALLBACK: Improved regret minimization with recent bias
    const h = AI_MEMORY.enemyHistory
    if (h.length > 0) {
        const counts = { rock: 0, paper: 0, scissor: 0 }
        const recentCounts = { rock: 0, paper: 0, scissor: 0 }

        // Weight recent moves more heavily
        h.forEach((m, i) => {
            const weight = Math.pow(0.9, h.length - 1 - i) // Exponential decay
            counts[m] += weight
            if (i >= h.length - 5) recentCounts[m]++ // Last 5 moves
        })

        const totalWeight = Object.values(counts).reduce((a, b) => a + b, 0)

        let bestMove = available[0]
        let bestScore = -Infinity

        available.forEach(move => {
            const beats = counter(counter(move)) // what we beat
            const losesTo = counter(move) // what beats us
            const winProb = (counts[beats] || 0) / totalWeight
            const loseProb = (counts[losesTo] || 0) / totalWeight
            const drawProb = (counts[move] || 0) / totalWeight

            // Recent trend bonus (last 5 moves)
            const recentBeats = recentCounts[beats] || 0
            const recentTotal = Math.max(Object.values(recentCounts).reduce((a, b) => a + b, 0), 1)
            const recentWinProb = recentBeats / recentTotal

            // Expected score with recent trend weighting
            const expectedScore = winProb * 1 + drawProb * 0 + loseProb * (-1)
            const recentBoost = recentWinProb * 0.2 // 20% weight on recent trend

            // Resource management bonus
            const chargeBonus = move === "rock" ? (rock > paper ? 0.03 : 0) :
                move === "paper" ? (paper > scissor ? 0.03 : 0) :
                    (scissor > rock ? 0.03 : 0)

            const totalScore = expectedScore * 0.8 + recentBoost + chargeBonus

            if (totalScore > bestScore) {
                bestScore = totalScore
                bestMove = move
            }
        })

        // Only use fallback if score is reasonable (raised from -0.3 to -0.15)
        if (bestScore > -0.15) {
            AI_MEMORY.lastMethod = "random"
            console.log(`AI FALLBACK → regret min: ${bestMove} (score: ${bestScore.toFixed(2)})`)
            return bestMove
        }
    }

    // Pure random fallback
    AI_MEMORY.lastMethod = "random"
    return available[Math.floor(Math.random() * available.length)]
}

function smartLootIndex(run) {

    updateBuild()

    const options = run.lootOptions || []
    const myHP = run?.players?.[0]?.health?.current ?? 0
    const room = run.currentRoom || 1

    let bestIndex = 0
    let bestScore = -9999

    options.forEach((opt, i) => {

        let score = 0
        const type = opt.boonTypeString?.toLowerCase() || ""

        // ===== RARITY =====
        score += (opt.RARITY_CID || 0) * 50

        // ===== PHASE LOGIC =====
        if (room <= 4) score += 50        // early → damage
        if (room >= 10) score += 30       // late → sustain

        // ===== HEAL =====
        if (type.includes("heal")) {
            if (myHP < 20) score += 1000
            else if (room >= 10) score += 200
            else score += 50
        }

        // ===== SKIP MAX HEALTH =====
        if (type.includes("maxhealth")) {
            score -= 400
        }

        // ===== ARMOR =====
        if (type.includes("maxarmor")) {
            score += 350
            if (room >= 10) score += 200
        }

        // ===== BUILD FOCUS =====
        if (type.includes("upgraderock")) {
            score += 200 + (opt.selectedVal1 || 0) * 50
            if (AI_MEMORY.build === "rock") score += 300
        }

        if (type.includes("upgradepaper")) {
            score += 180 + (opt.selectedVal1 || 0) * 40
            if (AI_MEMORY.build === "paper") score += 300
        }

        if (type.includes("upgradescissor")) {
            score += 150 + (opt.selectedVal1 || 0) * 30
            if (AI_MEMORY.build === "scissor") score += 300
        }

        // ===== BALANCED MODE =====
        if (AI_MEMORY.build === "balanced") {
            score += 50
        }

        // ===== MARKOV RANDOM =====
        score += Math.random() * 15

        console.log(`Option ${i}: ${opt.boonTypeString} → score: ${score}`)

        if (score > bestScore) {
            bestScore = score
            bestIndex = i
        }

    })

    console.log("AI BUILD:", AI_MEMORY.build)
    console.log("Chosen index:", bestIndex)

    return bestIndex
}

function updateBuild() {
    const recent = AI_MEMORY.history.slice(-10)
    const loseCount = recent.filter(x => x === "lose").length
    const winCount = recent.filter(x => x === "win").length
    const recentRate = getRecentWinRate(10)

    // Check historical build performance for optimization
    const bestBuild = getBestBuild()
    const currentBuildWinrate = getBuildWinrate(AI_MEMORY.build)
    const bestBuildWinrate = getBuildWinrate(bestBuild)

    // Use historical data if we have enough samples and significant difference
    if (AI_MEMORY.sessionStats.totalGames > 50 && bestBuild !== AI_MEMORY.build && bestBuildWinrate > currentBuildWinrate + 5) {
        console.log(`AI HISTORICAL OPTIMIZE → switch from ${AI_MEMORY.build}(${currentBuildWinrate}%) to ${bestBuild}(${bestBuildWinrate}%)`)
        console.log("Build winrates:", {
            balanced: getBuildWinrate('balanced') + "%",
            rock: getBuildWinrate('rock') + "%",
            paper: getBuildWinrate('paper') + "%",
            scissor: getBuildWinrate('scissor') + "%"
        })
        AI_MEMORY.build = bestBuild
        return
    }

    // CRITICAL: Immediate adaptation on severe losing streak
    if (AI_MEMORY.consecutiveLosses >= 2) {
        const builds = ["rock", "paper", "scissor"]
        const currentIdx = builds.indexOf(AI_MEMORY.build)
        // Skip 1 build ahead instead of cycling sequentially
        AI_MEMORY.build = builds[(currentIdx + 2) % 3]
        AI_MEMORY.consecutiveLosses = 0
        console.log("AI CRITICAL ADAPT → switch build to", AI_MEMORY.build, "(2 losses)")
        return
    }

    // EMERGENCY: 3+ losses in recent 5 games
    if (loseCount >= 3 && winCount <= 1) {
        const builds = ["rock", "paper", "scissor"]
        const currentIdx = builds.indexOf(AI_MEMORY.build)
        AI_MEMORY.build = builds[(currentIdx + 1) % 3]
        console.log("AI EMERGENCY ADAPT → switch build to", AI_MEMORY.build, "(3/5 losses)")
        return
    }

    // Normal adaptation: poor performance
    if (recentRate < 45 && loseCount >= 3) {
        const builds = ["rock", "paper", "scissor"]
        const currentIdx = builds.indexOf(AI_MEMORY.build)
        AI_MEMORY.build = builds[(currentIdx + 1) % 3]
        console.log("AI ADAPT → switch build to", AI_MEMORY.build, "(poor winrate)")
    }

    // Reinforce on strong winning streak
    if (AI_MEMORY.winStreak >= 4) {
        console.log("AI REINFORCE → keep build", AI_MEMORY.build, "(win streak:", AI_MEMORY.winStreak, ")")
    }

    // Entropy-based adaptation: if opponent is very predictable, focus on countering their favorite
    const h = AI_MEMORY.enemyHistory
    if (h.length > 10) {
        const counts = { rock: 0, paper: 0, scissor: 0 }
        h.forEach(m => counts[m]++)
        const fav = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b)
        const favPct = counts[fav] / h.length

        // If enemy has clear favorite (>40%), adapt to counter it
        if (favPct > 0.4 && AI_MEMORY.build === "balanced") {
            AI_MEMORY.build = counter(fav)
            console.log("AI ENTROPY ADAPT → counter enemy favorite", fav)
        }
    }
}

//====================== API =============================== //
async function sendAction(action, index = 0, retry = 0) {

    const payload = {
        action,
        actionToken,
        dungeonId,
        data: {
            consumables: [],
            itemId: 0,
            expectedAmount: 0,
            index,
            isJuiced: false,
            gearInstanceIds: []
        }
    }

    try {

        const res = await axios.post(API, payload, { headers })

        const data = res.data

        if (data?.actionToken) {
            actionToken = data?.actionToken
        }

        if (data?.data?.run) {
            run = data.data.run
        }
        if (data?.data?.events) {
            events = data.data.events
        }

        return data

    } catch (err) {

        const data = err.response?.data
        const status = err.response?.status

        if (data?.actionToken) {
            actionToken = data?.actionToken
        }

        // Exit immediately on 401 (unauthorized) - token expired
        if (status === 401) {
            console.log("Request error: 401 Unauthorized - Token expired")
            return null
        }

        if (retry < 3) {

            console.log("Retry request...")

            await sleep(3000)

            return sendAction(action, index, retry + 1)
        }

        console.log("Request error:", data?.message || err.message)

        return null
    }
}

// ========== ADVANCED PREDICTION ALGORITHMS ==========

// N-GRAM: Detect repeating sequences of length n
function predictByNgram(n) {
    const h = AI_MEMORY.enemyHistory
    if (h.length < n + 2) return null

    const recent = h.slice(-n).join(",")
    const occurrences = []

    for (let i = 0; i <= h.length - n - 1; i++) {
        const seq = h.slice(i, i + n).join(",")
        if (seq === recent) {
            occurrences.push(h[i + n])
        }
    }

    if (occurrences.length < 2) return null

    // Count what follows the pattern
    const counts = { rock: 0, paper: 0, scissor: 0 }
    occurrences.forEach(m => counts[m]++)

    const best = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b)
    const confidence = counts[best] / occurrences.length

    return confidence >= 0.5 ? best : null
}

// STREAK: Detect if enemy plays same move 2+ times
function detectStreak() {
    const h = AI_MEMORY.enemyHistory
    if (h.length < 2) return null

    const last2 = h.slice(-2)
    const last3 = h.slice(-3)

    // 3-streak: very strong signal (70% continue, 30% break)
    if (last3.length === 3 && last3[0] === last3[1] && last3[1] === last3[2]) {
        return last3[2]
    }

    // 2-streak: moderate signal (55% continue based on data)
    if (last2[0] === last2[1]) {
        // Check historical pattern: after 2-streak, does enemy continue?
        let continueCount = 0
        let breakCount = 0
        for (let i = 2; i < h.length; i++) {
            if (h[i - 2] === h[i - 1]) { // found a 2-streak ending at i-1
                if (h[i] === h[i - 1]) {
                    continueCount++
                } else {
                    breakCount++
                }
            }
        }
        // If we have data and enemy tends to break 2-streaks, predict break
        if (continueCount + breakCount >= 3) {
            if (breakCount > continueCount) {
                // Enemy tends to break 2-streaks, predict the break move
                return counter(last2[1]) // they play what beats their streak
            }
        }
        return last2[1] // default: predict continuation
    }

    return null
}

// MARKOV ORDER N: Higher-order Markov chain
function predictMarkovOrder(order) {
    const h = AI_MEMORY.enemyHistory
    if (h.length < order + 3) return null

    const context = h.slice(-order)
    const transitions = { rock: 0, paper: 0, scissor: 0 }
    let total = 0

    for (let i = 0; i <= h.length - order - 1; i++) {
        const slice = h.slice(i, i + order)
        if (slice.join(",") === context.join(",")) {
            transitions[h[i + order]]++
            total++
        }
    }

    if (total < 2) return null

    const best = Object.keys(transitions).reduce((a, b) =>
        transitions[a] > transitions[b] ? a : b
    )
    const confidence = transitions[best] / total

    return confidence >= 0.5 ? best : null
}

// ROTATION: Detect rock→paper→scissor cycling
function detectRotation() {
    const h = AI_MEMORY.enemyHistory
    if (h.length < 4) return null

    const last4 = h.slice(-4)

    // Check for +1 rotation (rock→paper→scissor→rock)
    const nextMap = { rock: "paper", paper: "scissor", scissor: "rock" }
    let rotationScore = 0

    for (let i = 0; i < last4.length - 1; i++) {
        if (nextMap[last4[i]] === last4[i + 1]) rotationScore++
    }

    if (rotationScore >= 2) {
        return nextMap[last4[last4.length - 1]]
    }

    // Check for -1 rotation (reverse cycle)
    const prevMap = { rock: "scissor", paper: "rock", scissor: "paper" }
    let reverseScore = 0

    for (let i = 0; i < last4.length - 1; i++) {
        if (prevMap[last4[i]] === last4[i + 1]) reverseScore++
    }

    if (reverseScore >= 2) {
        return prevMap[last4[last4.length - 1]]
    }

    return null
}

// EXPLOITATIVE: Counter the counter (anti-meta)
function predictExploitative() {
    const myLast = AI_MEMORY.myMoveHistory.slice(-1)[0]
    if (!myLast) return null

    // If enemy is countering us, they play what beats our last move
    // So we play what beats that
    const whatBeatsMyLast = counter(myLast)
    return whatBeatsMyLast
}

// FREQUENCY with exponential decay
function predictByFrequencyExp() {
    const h = AI_MEMORY.enemyHistory
    if (h.length === 0) return null

    const counts = { rock: 0, paper: 0, scissor: 0 }
    const decay = 0.9 // exponential decay factor

    h.forEach((m, i) => {
        const weight = Math.pow(decay, h.length - 1 - i)
        counts[m] += weight
    })

    return Object.keys(counts).reduce((a, b) =>
        counts[a] > counts[b] ? a : b
    )
}

// CHARGE EXPLOITATION: Detect when enemy is forced into specific moves due to charge depletion
function predictByChargeDepletion(run) {
    if (!run?.players?.[1]) return null

    const enemy = run.players[1]
    const rockCharges = enemy.rock?.currentCharges ?? 0
    const paperCharges = enemy.paper?.currentCharges ?? 0
    const scissorCharges = enemy.scissor?.currentCharges ?? 0

    const total = rockCharges + paperCharges + scissorCharges
    if (total === 0) return null

    // If enemy has only 1 charge type left, they're forced to play it
    const availableMoves = []
    if (rockCharges > 0) availableMoves.push('rock')
    if (paperCharges > 0) availableMoves.push('paper')
    if (scissorCharges > 0) availableMoves.push('scissor')

    // If only 1 move available, 100% confidence
    if (availableMoves.length === 1) {
        return availableMoves[0]
    }

    // If 2 moves available and one is very low, likely to play the higher one
    if (availableMoves.length === 2) {
        const charges = {
            rock: rockCharges,
            paper: paperCharges,
            scissor: scissorCharges
        }
        // Check if one move has significantly more charges (3+ difference)
        const sorted = availableMoves.sort((a, b) => charges[b] - charges[a])
        if (charges[sorted[0]] - charges[sorted[1]] >= 3) {
            // High probability they'll play the move with more charges
            // to conserve the scarce one
            return sorted[0]
        }
    }

    return null
}

// ========== ADVANCED PREDICTION ALGORITHMS V2 ==========

// DOUBLE-THINK: Predict what opponent predicts we'll play
// If we've been winning, opponent might try to counter our last move
function predictDoubleThink() {
    const myLast = AI_MEMORY.myMoveHistory.slice(-1)[0]
    if (!myLast) return null

    // If we're on a win streak, opponent likely tries to counter our last move
    if (AI_MEMORY.winStreak >= 2) {
        // Opponent will play what beats our last move (counter(myLast))
        // We return what opponent will play, and let chooseMove counter it
        return counter(myLast)
    }

    // If we just lost, opponent might repeat their winning move
    // We should counter their last move (handled by other strategies)
    return null
}

// LEVEL-3 THINKING: Counter the double-think (for advanced opponents)
function predictLevel3() {
    const myLast = AI_MEMORY.myMoveHistory.slice(-1)[0]
    const h = AI_MEMORY.enemyHistory
    if (!myLast || h.length < 5) return null

    // Check if opponent is a level-2 thinker (adapts to our patterns)
    // They might expect us to change after a win streak
    if (AI_MEMORY.winStreak >= 3) {
        // After a long win streak, opponent expects us to change
        // They'll play what beats what would beat our last move
        // So we play our last move again (they won't expect it)
        return counter(counter(myLast)) // what we'd play if we changed
    }

    return null
}

// MIRROR DETECTION: Detect if opponent mirrors our moves
function detectMirror() {
    const h = AI_MEMORY.enemyHistory
    const myH = AI_MEMORY.myMoveHistory
    if (h.length < 4 || myH.length < 4) return null

    // Check if opponent played same as our previous move
    let mirrorCount = 0
    for (let i = 1; i <= 4; i++) {
        if (h[h.length - i] === myH[myH.length - i - 1]) {
            mirrorCount++
        }
    }

    AI_MEMORY.isEnemyMirroring = mirrorCount >= 3
    AI_MEMORY.mirrorConfidence = mirrorCount / 4

    if (AI_MEMORY.isEnemyMirroring) {
        // If opponent mirrors our last move, they'll play what we played
        // So we should play what beats our own last move
        const myLast = myH[myH.length - 1]
        return myLast // they'll mirror this, so we counter it
    }

    return null
}

// ANTI-MIRROR: Counter the mirror strategy
function predictAntiMirror() {
    if (!AI_MEMORY.isEnemyMirroring) return null

    const myLast = AI_MEMORY.myMoveHistory.slice(-1)[0]
    if (!myLast) return null

    // If opponent mirrors our moves, play what beats our own last move
    return counter(myLast)
}

// COUNTER-ROTATION: Detect if opponent is cycling to counter us
function detectCounterRotation() {
    const h = AI_MEMORY.enemyHistory
    const myH = AI_MEMORY.myMoveHistory
    if (h.length < 4 || myH.length < 5) return null

    // Check if opponent plays what would beat our move from 2 turns ago
    // This is a common adaptation pattern
    let counterRotCount = 0
    for (let i = 2; i <= 4; i++) {
        const myMove2Ago = myH[myH.length - i]
        const oppMoveNow = h[h.length - i + 1]
        if (oppMoveNow === counter(myMove2Ago)) {
            counterRotCount++
        }
    }

    if (counterRotCount >= 2) {
        // Opponent is trying to counter our delayed moves
        const myLast = myH[myH.length - 1]
        // Play what they think we'll play (one level up)
        return counter(counter(myLast))
    }

    return null
}

// ALTERNATING PATTERN: Detect if opponent alternates between 2 moves
function detectAlternating() {
    const h = AI_MEMORY.enemyHistory
    if (h.length < 4) return null

    const last4 = h.slice(-4)

    // Check for A-B-A-B pattern
    if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]) {
        return last4[1] // next should be the one at index 1 (continuing A-B-A-B-A)
    }

    // Check for A-A-B-B pattern (double alternation)
    if (h.length >= 6) {
        const last6 = h.slice(-6)
        if (last6[0] === last6[1] && last6[2] === last6[3] && last6[4] === last6[5] &&
            last6[0] !== last6[2] && last6[2] !== last6[4] && last6[0] !== last6[4]) {
            // Pattern like rock-rock-paper-paper-scissor-scissor
            // Next could be any, but likely rock again (cycle)
            return last6[0]
        }
    }

    return null
}

// TRANSITION PATTERN: Detect how opponent responds to wins/losses
function predictTransition() {
    const h = AI_MEMORY.enemyHistory
    const outcomes = AI_MEMORY.history
    if (h.length < 3 || outcomes.length < 2) return null

    // Track what opponent does after they win vs after they lose
    const afterEnemyWin = []
    const afterEnemyLose = []

    for (let i = 1; i < Math.min(h.length, outcomes.length); i++) {
        if (outcomes[outcomes.length - i] === "win") {
            // We won, so enemy lost -> their previous move
            afterEnemyLose.push(h[h.length - i])
        } else if (outcomes[outcomes.length - i] === "lose") {
            // We lost, so enemy won
            afterEnemyWin.push(h[h.length - i])
        }
    }

    // If we know the last outcome, predict based on pattern
    const lastOutcome = AI_MEMORY.lastResult
    let relevantMoves = []

    if (lastOutcome === "win") {
        // Enemy just lost - what do they typically play after losing?
        relevantMoves = afterEnemyLose
    } else if (lastOutcome === "lose") {
        // Enemy just won - what do they typically play after winning?
        relevantMoves = afterEnemyWin
    }

    if (relevantMoves.length === 0) return null

    // Count occurrences
    const counts = { rock: 0, paper: 0, scissor: 0 }
    relevantMoves.forEach(m => counts[m]++)

    const best = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b)
    const confidence = counts[best] / relevantMoves.length

    return confidence >= 0.5 ? best : null
}

// RESPONSE TO OUR MOVES: Detect how opponent responds to our specific moves
function predictResponseToOurMoves() {
    const myHistory = AI_MEMORY.myMoveHistory
    const enemyHistory = AI_MEMORY.enemyHistory

    if (myHistory.length < 3 || enemyHistory.length < 3) return null

    const myLast = myHistory[myHistory.length - 1]

    // Count what enemy plays after we play myLast
    const responses = { rock: 0, paper: 0, scissor: 0 }
    let total = 0

    for (let i = 0; i < myHistory.length - 1; i++) {
        if (myHistory[i] === myLast) {
            const enemyResponse = enemyHistory[i + 1]
            if (enemyResponse) {
                responses[enemyResponse]++
                total++
            }
        }
    }

    if (total < 2) return null

    // Find most common response
    const best = Object.keys(responses).reduce((a, b) =>
        responses[a] > responses[b] ? a : b
    )

    const confidence = responses[best] / total
    return confidence >= 0.55 ? best : null
}

// BAYESIAN PREDICTION: Update beliefs based on observations
function predictBayesian() {
    const h = AI_MEMORY.enemyHistory
    if (h.length < 3) return null

    // Update Dirichlet distribution
    AI_MEMORY.bayesianStats = {
        rock: { alpha: 1, beta: 1 },
        paper: { alpha: 1, beta: 1 },
        scissor: { alpha: 1, beta: 1 }
    }

    h.forEach(move => {
        AI_MEMORY.bayesianStats[move].alpha++
    })

    // Calculate expected probabilities
    const total = h.length + 3 // prior pseudo-counts
    const probs = {
        rock: AI_MEMORY.bayesianStats.rock.alpha / total,
        paper: AI_MEMORY.bayesianStats.paper.alpha / total,
        scissor: AI_MEMORY.bayesianStats.scissor.alpha / total
    }

    // Add recency bias
    const recent = h.slice(-5)
    recent.forEach((move, i) => {
        probs[move] += 0.1 * (i + 1) / recent.length
    })

    const best = Object.keys(probs).reduce((a, b) => probs[a] > probs[b] ? a : b)

    // Only return if significantly higher than uniform (0.33)
    return probs[best] > 0.4 ? best : null
}

// ENTROPY CALCULATION: Measure predictability
function calculateEntropy() {
    const h = AI_MEMORY.enemyHistory
    if (h.length < 5) return 1.0 // maximum uncertainty

    const counts = { rock: 0, paper: 0, scissor: 0 }
    h.forEach(m => counts[m]++)

    const total = h.length
    let entropy = 0

    Object.values(counts).forEach(count => {
        if (count > 0) {
            const p = count / total
            entropy -= p * Math.log2(p)
        }
    })

    // Normalize (max entropy for 3 outcomes is log2(3) ≈ 1.585)
    return entropy / 1.585
}

// DYNAMIC THRESHOLD: Adjust confidence threshold based on recent performance
function getDynamicThreshold() {
    const recentRate = parseFloat(getRecentWinRate(10)) // Use shorter window for faster adaptation
    const entropy = calculateEntropy()

    // OPTIMIZED: Higher base threshold to avoid low-confidence plays
    // When losing badly, we need BETTER predictions, not more random plays
    let baseThreshold = 0.52

    if (recentRate < 35) {
        baseThreshold = 0.48 // Still risky but not too low
    } else if (recentRate > 65) {
        baseThreshold = 0.58 // Be more selective when winning
    }

    // Only reduce threshold slightly for high entropy opponents
    if (entropy > 0.85) {
        baseThreshold -= 0.05
    }

    // RAISED MINIMUM: Never go below 0.45 to avoid bad plays
    AI_MEMORY.dynamicThreshold = Math.max(0.45, Math.min(0.62, baseThreshold))
    return AI_MEMORY.dynamicThreshold
}

// Legacy compatibility functions
function predictEnemyAdvanced() {
    return predictMarkovOrder(1)
}

function predictByFrequency() {
    return predictByFrequencyExp()
}

function detectPattern() {
    return predictByNgram(3)
}

function antiCounter() {
    const exploitative = predictExploitative()
    return exploitative ? counter(exploitative) : null
}
function judgeResult(myMove, enemyMove) {

    if (!myMove || !enemyMove) return null

    if (myMove === enemyMove) return "draw"

    if (
        (myMove === "rock" && enemyMove === "scissor") ||
        (myMove === "paper" && enemyMove === "rock") ||
        (myMove === "scissor" && enemyMove === "paper")
    ) {
        return "win"
    }

    return "lose"
}

const ADDRESS = "0x7DdbdaB222167da2C2AC6722Da69961C8A7e3D69"

async function startDungeon() {

    console.log("===== CHECK ENERGY =====")

    const energy = await getEnergy(ADDRESS)

    // ❌ KHÔNG ĐỦ ENERGY → THOÁT
    if (energy < 40) {
        process.exit(0)
    }

    console.log("===== START NEW DUNGEON =====")

    actionToken = ""
    dungeonId = 1

    const res = await sendAction("start_run")

    if (res?.data?.run) {
        run = res.data.run
    }

    await sleep(8000)
}

async function doLoot() {

    if (!run?.lootOptions) return

    console.log("===== LOOT PHASE =====")

    const myHP = run?.players?.[0]?.health?.current ?? 0

    run.lootOptions.forEach((x, i) => {
        console.log(i, x.boonTypeString)
    })

    let index = smartLootIndex(run)

    // ưu tiên heal nếu HP thấp
    if (myHP < 10) {

        const healIndex = run.lootOptions.findIndex(
            x => x.boonTypeString?.toLowerCase().includes("heal")
        )

        if (healIndex !== -1) {
            index = healIndex
            console.log("Low HP → picking HEAL")
        }

    }

    await sendAction("loot_one", index)

    await sleep(4000)

}

async function getEnergy(address) {

    try {

        const url = `https://gigaverse.io/api/offchain/player/energy/${address}`

        const res = await axios.get(url, { headers })

        const energy =
            res.data?.entities?.[0]?.parsedData?.energyValue ?? 0

        console.log("Current Energy:", energy)

        return energy

    } catch (err) {

        console.log("Get energy error:", err.message)

        return 0
    }
}

async function startBot() {

    console.log("BOT STARTED")

    // Load persisted history for optimization
    loadHistory()

    await startDungeon()

    while (true) {

        if (!run) {

            const energy = await getEnergy(ADDRESS)

            if (energy < 40) {
                console.log("Idle → waiting energy")
                await sleep(60000)
                break
            }

            console.log("Waiting for run data")
            await sleep(3000)
            continue
        }

        // const room = parseInt(run.players[1].id.match(/\d+/)[0]) + 1

        // const wave = getWave(room)

        // console.log("Current Wave:", wave)

        if (run.lootPhase) {

            await doLoot()

            continue
        }


        const move = chooseMove(run)

        if (!move) {
            console.log("No charges → restart dungeon")
            await startDungeon()
            continue
        }

        // Track our intended move before sending
        AI_MEMORY.myMoveHistory.push(move)
        if (AI_MEMORY.myMoveHistory.length > 30) AI_MEMORY.myMoveHistory.shift()

        await sendAction(move)

        const myMove = events[0]?.value
        const enemyMove = events[1]?.value

        console.log("Enemy move:", enemyMove)
        console.log("Bot move:", myMove)

        if (myMove && enemyMove) {
            const result = judgeResult(myMove, enemyMove)
            AI_MEMORY.lastResult = result

            // Update method performance
            updateMethodPerformance(result)

            if (result === "draw") {
                STATS.draws++
            } else if (result) {
                STATS.total++
                if (result === "win") STATS.win++
                if (result === "lose") STATS.lose++
                AI_MEMORY.history.push(result)
                if (AI_MEMORY.history.length > 50) AI_MEMORY.history.shift()
            }
            console.log("RESULT:", result, "| Method:", AI_MEMORY.lastMethod, "| Streak:", AI_MEMORY.winStreak)

            // Record detailed game data for optimization
            recordDetailedGame(myMove, enemyMove, result, AI_MEMORY.lastMethod)
        }

        console.log({
            globalWinrate: getGlobalWinrate() + "%",
            // wave,
            result: AI_MEMORY.lastResult,
            winrate: getWinRate(),
            recentWinrate: getRecentWinRate(10),
            bestMethod: getBestMethod(),
            confidence: AI_MEMORY.patternConfidence.toFixed(2),
            threshold: AI_MEMORY.dynamicThreshold.toFixed(2),
            entropy: calculateEntropy().toFixed(2),
            mirror: AI_MEMORY.isEnemyMirroring ? "YES" : "NO"
        })

        if (enemyMove) {
            AI_MEMORY.enemyHistory.push(enemyMove)
            if (AI_MEMORY.enemyHistory.length > 50) {
                AI_MEMORY.enemyHistory.shift()
            }
        }

        const enemyHP = run?.players[1]?.health?.current ?? 0
        const myHP = run?.players[0]?.health?.current ?? 0
        console.log("enemyHP:", enemyHP)
        console.log("myHP:", myHP)
        console.log("EnemyHistory:", AI_MEMORY.enemyHistory.slice(-20).join("→"))

        // Periodic stats report every 10 games
        if (AI_MEMORY.sessionStats.totalGames % 10 === 0 && AI_MEMORY.sessionStats.totalGames > 0) {
            console.log("\n===== PERIODIC STATS REPORT =====")
            console.log(`Total Games: ${AI_MEMORY.sessionStats.totalGames}`)
            console.log(`Global Winrate: ${getGlobalWinrate()}%`)
            console.log(`Current Session: ${STATS.win}W / ${STATS.lose}L (${getWinRate()}%)`)
            console.log(`Best Win Streak: ${AI_MEMORY.sessionStats.bestWinStreak}`)
            console.log(`Worst Loss Streak: ${AI_MEMORY.sessionStats.worstLossStreak}`)
            console.log(`Best Build: ${getBestBuild()} (${getBuildWinrate(getBestBuild())}%)`)
            console.log(`Charge Efficiency - Rock: ${getChargeWinrate('rock')}%, Paper: ${getChargeWinrate('paper')}%, Scissor: ${getChargeWinrate('scissor')}%`)
            console.log(`Best Method: ${getBestMethod()}`)
            console.log("=================================\n")
        }

        if (enemyHP <= 0) {
            console.log("Enemy defeated")
            await sleep(6000)
            continue
        }

        if (myHP <= 0) {
            console.log("Player died")
            await startDungeon()
            continue
        }

        const d = randomDelay()

        console.log("Next move:", d / 1000, "seconds")

        await sleep(d)

        if (!run?.players || !run.players[1]) {
            console.log("Invalid run → restart")
            await startDungeon()
            continue
        }
    }

}

//startBot()

// ================= MULTI-ACCOUNT SUPPORT =================
// Add this to .env file for multi-account:
// TOKEN_1=your_first_token
// TOKEN_2=your_second_token
// TOKEN_3=your_third_token
// ADDRESS_1=0x...
// ADDRESS_2=0x...
// ...etc

class BotAccount {
    constructor(index, token, address) {
        this.index = index
        this.token = token
        this.address = address || ""

        // Instance-specific state (copied from global)
        this.actionToken = ""
        this.dungeonId = 1
        this.run = null
        this.events = null

        this.headers = {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            origin: "https://gigaverse.io",
            referer: "https://gigaverse.io/play"
        }

        // AI Memory per account
        this.aiMemory = {
            build: "balanced",
            lastResult: null,
            history: [],
            enemyHistory: [],
            myMoveHistory: [],
            methodPerformance: {
                pattern: { win: 0, loss: 0 },
                markov2: { win: 0, loss: 0 },
                markov1: { win: 0, loss: 0 },
                ngram: { win: 0, loss: 0 },
                streak: { win: 0, loss: 0 },
                frequency: { win: 0, loss: 0 },
                exploitative: { win: 0, loss: 0 },
                random: { win: 0, loss: 0 },
                doublethink: { win: 0, loss: 0 },
                mirror: { win: 0, loss: 0 },
                antimirror: { win: 0, loss: 0 },
                counterrot: { win: 0, loss: 0 },
                bayesian: { win: 0, loss: 0 },
                transition: { win: 0, loss: 0 }
            },
            lastMethod: null,
            consecutiveLosses: 0,
            winStreak: 0,
            patternConfidence: 0,
            dynamicThreshold: 0.5,
            lastOutcomeWasLoss: false,
            enemyResponseToLoss: [],
            enemyResponseToWin: [],
            isEnemyMirroring: false,
            mirrorConfidence: 0,
            bayesianStats: {
                rock: { alpha: 1, beta: 1 },
                paper: { alpha: 1, beta: 1 },
                scissor: { alpha: 1, beta: 1 }
            },
            sessionStats: {
                totalGames: 0,
                wins: 0,
                losses: 0,
                draws: 0,
                bestWinStreak: 0,
                worstLossStreak: 0,
                buildStats: {
                    rock: { wins: 0, losses: 0, uses: 0 },
                    paper: { wins: 0, losses: 0, uses: 0 },
                    scissor: { wins: 0, losses: 0, uses: 0 },
                    balanced: { wins: 0, losses: 0, uses: 0 }
                },
                chargeStats: {
                    rock: { wins: 0, uses: 0 },
                    paper: { wins: 0, uses: 0 },
                    scissor: { wins: 0, uses: 0 }
                },
                methodStats: {}
            },
            consecutiveWins: 0,
            consecutiveLosses: 0,
            lastBuildChange: 0
        }

        this.stats = {
            win: 0,
            lose: 0,
            total: 0,
            draws: 0
        }

        // Success rate tracking
        this.recentSuccessRate = 1.0

        // History file for this account
        this.historyFile = path.join(__dirname, `bot_history_${index}.json`)

        // Load persisted history
        this.loadHistory()
    }

    log(msg) {
        console.log(`[ACC${this.index}] ${msg}`)
    }

    loadHistory() {
        try {
            if (fs.existsSync(this.historyFile)) {
                const data = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'))
                if (data.stats) this.stats = data.stats
                if (data.aiMemory) {
                    this.aiMemory = { ...this.aiMemory, ...data.aiMemory }
                }
                this.log(`Loaded history: ${this.stats.total} games (${this.stats.win}W/${this.stats.lose}L)`)
            }
        } catch (e) {
            this.log(`Error loading history: ${e.message}`)
        }
    }

    saveHistory() {
        try {
            fs.writeFileSync(this.historyFile, JSON.stringify({
                stats: this.stats,
                aiMemory: {
                    history: this.aiMemory.history,
                    enemyHistory: this.aiMemory.enemyHistory,
                    myMoveHistory: this.aiMemory.myMoveHistory,
                    methodPerformance: this.aiMemory.methodPerformance,
                    sessionStats: this.aiMemory.sessionStats
                }
            }, null, 2))
        } catch (e) {
            this.log(`Error saving history: ${e.message}`)
        }
    }

    reloadToken() {
        // Re-read .env file to get potentially updated token
        dotenv.config({ override: true })

        const tokenVar = this.index === 1 && process.env.TOKEN ? "TOKEN" : `TOKEN_${this.index}`
        const newToken = process.env[tokenVar]

        if (newToken && newToken !== this.token) {
            this.token = newToken
            this.headers = {
                authorization: `Bearer ${newToken}`,
                "content-type": "application/json",
                origin: "https://gigaverse.io",
                referer: "https://gigaverse.io/play"
            }
            this.log(`Token reloaded from ${tokenVar}`)
            return true
        }

        return false
    }

    async sendAction(action, index = 0, retry = 0, tokenRetry = 0) {
        const payload = {
            action,
            actionToken: this.actionToken,
            dungeonId: this.dungeonId,
            data: {
                consumables: [],
                itemId: 0,
                expectedAmount: 0,
                index,
                isJuiced: false,
                gearInstanceIds: []
            }
        }

        try {
            const res = await axios.post(API, payload, { headers: this.headers })
            const data = res.data

            if (data?.actionToken) {
                this.actionToken = data.actionToken
            }
            if (data?.data?.run) {
                this.run = data.data.run
            }
            if (data?.data?.events) {
                this.events = data.data.events
            }

            this.updateSuccessRate(true)
            return data
        } catch (err) {
            const data = err.response?.data
            const status = err.response?.status
            if (data?.actionToken) {
                this.actionToken = data.actionToken
            }

            this.updateSuccessRate(false)

            // Handle 401 - try to reload token first
            if (status === 401 && tokenRetry < 3) {
                this.log(`Token expired (401), attempting to reload... (${tokenRetry + 1}/3)`)
                const reloaded = this.reloadToken()

                if (reloaded) {
                    this.log("Token reloaded successfully, retrying...")
                    await sleep(2000)
                    return this.sendAction(action, index, 0, tokenRetry + 1)
                } else {
                    this.log("Token not updated in .env, waiting...")
                    await sleep(10000) // Wait 10s for user to update .env
                    return this.sendAction(action, index, 0, tokenRetry + 1)
                }
            }

            if (retry < 3) {
                this.log(`Retry request... (${status || 'no status'})`)
                await sleep(3000)
                return this.sendAction(action, index, retry + 1, tokenRetry)
            }

            this.log(`Request error: ${status || 'unknown'} - ${data?.message || err.message}`)
            return null
        }
    }

    updateSuccessRate(success) {
        this.recentSuccessRate = this.recentSuccessRate * 0.8 + (success ? 1 : 0) * 0.2
    }

    async getEnergy() {
        if (!this.address) {
            this.log("No address set, skipping energy check")
            return 100
        }

        try {
            const url = `https://gigaverse.io/api/offchain/player/energy/${this.address}`
            this.log(`Fetching energy from: ${url}`)
            const res = await axios.get(url, { headers: this.headers })
            const energy = res.data?.entities?.[0]?.parsedData?.energyValue ?? 0
            this.log(`Energy API response: ${energy}`)
            return energy
        } catch (err) {
            this.log(`Energy API error: ${err.response?.status || err.message}`)
            return 0
        }
    }

    async startDungeon() {
        this.log("===== CHECK ENERGY =====")
        this.log(`Address: ${this.address || "NOT SET"}`)

        const energy = await this.getEnergy()
        this.log(`Energy: ${energy}`)

        if (energy < 40 && energy > 0) {
            this.log(`Not enough energy (${energy}), waiting...`)
            return false
        }

        // If energy is 0, API might have failed - try starting anyway
        if (energy === 0) {
            this.log("Energy API returned 0, will try to start anyway...")
        }

        this.log("===== START NEW DUNGEON =====")

        this.actionToken = ""
        this.dungeonId = 1

        const res = await this.sendAction("start_run")

        if (!res) {
            this.log("Failed to start dungeon after retries - checking if token needs update")
            // Try one more time with explicit token reload
            const reloaded = this.reloadToken()
            if (reloaded) {
                this.log("Token was updated, retrying start...")
                const retryRes = await this.sendAction("start_run")
                if (retryRes?.data?.run) {
                    this.run = retryRes.data.run
                    this.log("Dungeon started successfully!")
                    return true
                }
            }
            this.log("Could not start dungeon - please update TOKEN in .env file")
            return false
        }

        if (res?.data?.run) {
            this.run = res.data.run
            this.log("Dungeon started successfully!")
            // Sync instance state to global for the game loop
            actionToken = this.actionToken
            dungeonId = this.dungeonId
            run = this.run
            headers = this.headers
        } else {
            this.log(`Start dungeon failed: ${res?.message || 'Unknown error'}`)
            return false
        }

        await sleep(8000)
        return true
    }

    // Get methods that use instance state
    getWinRate() {
        const { win, lose } = this.stats
        const total = win + lose
        if (total === 0) return 0
        return ((win / total) * 100).toFixed(2)
    }

    getRecentWinRate(n = 20) {
        const recent = this.aiMemory.history.slice(-n)
        const wins = recent.filter(r => r === "win").length
        const total = recent.filter(r => r === "win" || r === "lose").length
        return total === 0 ? 0 : ((wins / total) * 100).toFixed(2)
    }

    async runBot() {
        this.log("BOT STARTED")
        let restartCount = 0
        const MAX_RESTARTS = 3

        let started = await this.startDungeon()
        if (!started) {
            // Try once more with potential token reload
            this.log("Failed to start dungeon, will retry once...")
            await sleep(5000)
            started = await this.startDungeon()
            if (!started) {
                this.log("Failed to start dungeon after retries - stopping")
                process.exit(1)
            }
        }

        let consecutiveFailures = 0
        const MAX_CONSECUTIVE_FAILURES = 5

        while (true) {
            // Check for loot phase using instance state only
            if (this.run?.lootPhase) {
                const lootSuccess = await this.doLoot()
                if (!lootSuccess) {
                    // If loot failed (e.g., already chosen), clear the flag to prevent infinite loop
                    this.run = { ...this.run, lootPhase: false }
                }
                consecutiveFailures = 0 // Reset on successful loot
                continue
            }

            if (!this.run) {
                restartCount++
                if (restartCount >= MAX_RESTARTS) {
                    this.log(`Too many failed restarts (${restartCount}), stopping bot`)
                    process.exit(1)
                }

                const energy = await this.getEnergy()

                if (energy < 40) {
                    this.log(`Energy too low (${energy}), stopping bot`)
                    process.exit(0)
                }

                const started = await this.startDungeon()
                if (!started) {
                    this.log("Failed to start, will exit")
                    process.exit(0)
                }
                // Reset counter on successful start
                restartCount = 0
            }

            // Note: Using instance methods instead of global functions
            // This ensures proper state isolation for multi-account mode

            // Loot phase - check instance state
            if (this.run?.lootPhase) {
                const lootSuccess = await this.doLoot()
                if (!lootSuccess) {
                    this.run = { ...this.run, lootPhase: false }
                }
                continue
            }

            // Get move from AI
            const move = chooseMove(this.run)

            if (!move) {
                this.log("No charges → restart dungeon")
                await this.startDungeon()
                continue
            }

            // Send action using instance method (has token reload logic)
            const actionResult = await this.sendAction(move)

            // Only track move after successful send
            if (actionResult) {
                AI_MEMORY.myMoveHistory.push(move)
                if (AI_MEMORY.myMoveHistory.length > 30) AI_MEMORY.myMoveHistory.shift()
            }

            // If action failed completely, try to recover
            if (!actionResult) {
                consecutiveFailures++
                this.log(`Action failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}) - checking if token needs reload...`)

                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    this.log("Too many consecutive failures, restarting dungeon...")
                    this.run = null
                    consecutiveFailures = 0
                    continue
                }

                const reloaded = this.reloadToken()
                if (reloaded) {
                    this.log("Token reloaded, retrying action...")
                    const retryResult = await this.sendAction(move)
                    if (!retryResult) {
                        this.log("Still failing after token reload, waiting...")
                        await sleep(10000)
                        continue
                    }
                    // Track move after successful retry
                    AI_MEMORY.myMoveHistory.push(move)
                    if (AI_MEMORY.myMoveHistory.length > 30) AI_MEMORY.myMoveHistory.shift()
                    consecutiveFailures = 0 // Reset on success
                } else {
                    this.log("Action failed, waiting before retry...")
                    await sleep(5000)
                    continue
                }
            } else {
                consecutiveFailures = 0 // Reset on success
            }

            // Use instance events directly (fresh from successful action)
            const updatedEnemyHP = this.run?.players?.[1]?.health?.current ?? 0

            // Safe access to events
            const myMove = this.events?.[0]?.value
            const enemyMove = this.events?.[1]?.value

            if (!myMove && !enemyMove) {
                // Events might be empty on first turn or dungeon just started
                // Check if we have a valid run state - if so, continue to next iteration
                if (this.run?.players?.[0]?.health?.current > 0) {
                    this.log("No events yet, continuing...")
                    await sleep(3000)
                    continue
                }
                this.log("No events data received and no valid run state, restarting...")
                await sleep(2000)
                continue
            }

            this.log(`Enemy move: ${enemyMove || 'unknown'} | Bot move: ${myMove || 'unknown'}`)

            if (myMove && enemyMove) {
                const result = judgeResult(myMove, enemyMove)
                AI_MEMORY.lastResult = result

                updateMethodPerformance(result)

                if (result === "draw") {
                    this.stats.draws++
                } else if (result) {
                    this.stats.total++
                    if (result === "win") this.stats.win++
                    if (result === "lose") this.stats.lose++
                    AI_MEMORY.history.push(result)
                    if (AI_MEMORY.history.length > 50) AI_MEMORY.history.shift()
                }

                this.log(`RESULT: ${result} | Method: ${AI_MEMORY.lastMethod} | Streak: ${AI_MEMORY.winStreak}`)

                // Save history after each game
                this.saveHistory()
            }

            this.log(`Session: ${getWinRate()}% | Total History: ${this.stats.win}W/${this.stats.lose}L (${this.getWinRate()}%) | Recent: ${getRecentWinRate(10)}%`)

            if (enemyMove) {
                AI_MEMORY.enemyHistory.push(enemyMove)
                if (AI_MEMORY.enemyHistory.length > 50) {
                    AI_MEMORY.enemyHistory.shift()
                }
            }

            const enemyHP = run?.players[1]?.health?.current ?? 0
            const myHP = run?.players[0]?.health?.current ?? 0

            if (enemyHP <= 0) {
                this.log("Enemy defeated")
                await sleep(6000)
                // Clear run to trigger new dungeon start on next iteration
                this.run = null
                continue
            }

            if (myHP <= 0) {
                this.log("Player died")
                const started = await this.startDungeon()
                if (!started) {
                    this.run = null  // Clear run so energy check runs next iteration
                }
                continue
            }

            const d = randomDelay()
            this.log(`Next move in ${(d / 1000).toFixed(1)}s`)
            await sleep(d)

            if (!run?.players || !run.players[1]) {
                this.log("Invalid run → restart")
                const started = await this.startDungeon()
                if (!started) {
                    this.run = null
                }
                continue
            }
        }
    }

    async doLoot() {
        if (!this.run?.lootOptions) return true

        this.log("===== LOOT PHASE =====")

        const myHP = this.run?.players?.[0]?.health?.current ?? 0

        this.run.lootOptions.forEach((x, i) => {
            this.log(`  ${i}: ${x.boonTypeString}`)
        })

        let index = smartLootIndex(this.run)

        if (myHP < 10) {
            const healIndex = this.run.lootOptions.findIndex(
                x => x.boonTypeString?.toLowerCase().includes("heal")
            )
            if (healIndex !== -1) {
                index = healIndex
                this.log("Low HP → picking HEAL")
            }
        }

        // Use instance sendAction instead of global to avoid state contamination
        const result = await this.sendAction("loot_one", index)

        await sleep(4000)

        // Return false on error to signal caller to clear lootPhase flag
        if (!result) {
            return false
        }

        return true
    }
}

// Parse multiple accounts from environment
function getAccountsFromEnv() {
    const accounts = []
    let index = 1

    while (true) {
        const token = process.env[`TOKEN_${index}`]
        const address = process.env[`ADDRESS_${index}`]

        if (!token) break

        accounts.push(new BotAccount(index, token, address))
        index++
    }

    // Also check for TOKEN (single account backward compat)
    if (accounts.length === 0 && process.env.TOKEN) {
        accounts.push(new BotAccount(1, process.env.TOKEN, process.env.ADDRESS))
    }

    return accounts
}

// Run multiple accounts
async function runMultiAccount() {
    const accounts = getAccountsFromEnv()

    if (accounts.length === 0) {
        console.log("No accounts configured. Set TOKEN_1, TOKEN_2, etc in .env")
        return
    }

    console.log(`Starting ${accounts.length} account(s)...`)

    // Run all accounts in parallel with staggered start
    const startPromises = accounts.map((acc, i) =>
        new Promise(resolve => {
            setTimeout(() => {
                acc.runBot().catch(err => {
                    console.error(`[ACC${acc.index}] Error:`, err.message)
                })
                resolve()
            }, i * 2000) // Stagger starts by 2 seconds
        })
    )

    await Promise.all(startPromises)
}

// Uncomment to use multi-account mode:
runMultiAccount()