import axios from "axios"
import dotenv from "dotenv"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

dotenv.config()

const API = "https://gigaverse.io/api/game/dungeon/action"

// Parse multiple accounts from env (TOKEN_1, ADDRESS_1, TOKEN_2, ADDRESS_2, ...)
function parseAccounts() {
    const accounts = []
    let i = 1
    while (true) {
        const token = process.env[`TOKEN_${i}`]
        const address = process.env[`ADDRESS_${i}`]
        if (!token) break
        accounts.push({
            id: i,
            token,
            address: address || process.env[`ADDRESS`]
        })
        i++
    }
    // Fallback to single account format
    if (accounts.length === 0 && process.env.TOKEN) {
        accounts.push({
            id: 1,
            token: process.env.TOKEN,
            address: process.env.ADDRESS
        })
    }
    return accounts
}

const ACCOUNTS = parseAccounts()

if (ACCOUNTS.length === 0) {
    console.error("No accounts found. Set TOKEN_1/ADDRESS_1, TOKEN_2/ADDRESS_2, etc. in .env")
    process.exit(1)
}

console.log(`Loaded ${ACCOUNTS.length} account(s)`)

// ================= AI LOGGING =================
const LOGS_DIR = path.join(__dirname, "logs")

function getLogFiles(accountId) {
    return {
        ai: path.join(LOGS_DIR, `gigaverse_farm_${accountId}.log`),
        perf: path.join(LOGS_DIR, `performance_${accountId}.log`),
        history: path.join(__dirname, `bot_history_${accountId}.json`)
    }
}

function ensureLogsDir() {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true })
}
ensureLogsDir()

function aiLog(logFile, type, data) {
    const entry = {
        ts: new Date().toISOString(),
        type,
        data
    }
    try {
        fs.appendFileSync(logFile, JSON.stringify(entry) + "\n")
    } catch { }
}

function perfLog(logFile, operation, durationMs, success, extra = {}) {
    const entry = {
        ts: new Date().toISOString(),
        op: operation,
        ms: durationMs,
        ok: success,
        ...extra
    }
    try {
        fs.appendFileSync(logFile, JSON.stringify(entry) + "\n")
    } catch { }
}

/** Adaptive timing based on success rate */
function createAdaptiveTimer() {
    let recentSuccessRate = 1.0
    return {
        update(success) {
            recentSuccessRate = recentSuccessRate * 0.8 + (success ? 1 : 0) * 0.2
        },
        delay(baseMin, baseMax) {
            const factor = 1 + (1 - recentSuccessRate) * 0.5
            return Math.floor(Math.random() * (baseMax * factor - baseMin * factor) + baseMin * factor)
        }
    }
}

function createAIMemory() {
    return {
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
}

function createStats() {
    return { win: 0, lose: 0, total: 0, draws: 0 }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
}

function randomDelay() {
    return Math.floor(Math.random() * 5000) + 3000
}

function getWinRate(stats) {
    const { win, lose } = stats
    const total = win + lose
    if (total === 0) return 0
    return ((win / total) * 100).toFixed(2)
}

function getRecentWinRate(memory, n = 20) {
    const recent = memory.history.slice(-n)
    const wins = recent.filter(r => r === "win").length
    const total = recent.filter(r => r === "win" || r === "lose").length
    return total === 0 ? 0 : ((wins / total) * 100).toFixed(2)
}

function getBestMethod(memory) {
    const methods = Object.entries(memory.methodPerformance)
    const scored = methods.map(([name, perf]) => {
        const total = perf.win + perf.loss
        const rate = total === 0 ? 0 : perf.win / total
        return { name, rate, total, score: rate * Math.min(total, 10) }
    })
    return scored.sort((a, b) => b.score - a.score)[0]?.name || "random"
}

function updateMethodPerformance(memory, result) {
    if (!memory.lastMethod) return
    const method = memory.lastMethod
    if (result === "win") {
        memory.methodPerformance[method].win++
        memory.winStreak++
        memory.consecutiveLosses = 0
        memory.sessionStats.bestWinStreak = Math.max(memory.sessionStats.bestWinStreak, memory.winStreak)
    } else if (result === "lose") {
        memory.methodPerformance[method].loss++
        memory.consecutiveLosses++
        memory.winStreak = 0
        memory.sessionStats.worstLossStreak = Math.max(memory.sessionStats.worstLossStreak, memory.consecutiveLosses)
    }
}

// ===== HISTORY PERSISTENCE =====
function loadHistory(memory, stats, historyFile, accountId) {
    try {
        if (fs.existsSync(historyFile)) {
            const data = JSON.parse(fs.readFileSync(historyFile, 'utf8'))

            memory.sessionStats = data.ss || data.sessionStats || memory.sessionStats
            memory.methodPerformance = data.mp || data.methodPerformance || memory.methodPerformance
            memory.enemyPatterns = data.ep || data.enemyPatterns || {}
            memory.dungeonStats = data.ds || data.dungeonStats || {}
            memory.chargeEfficiency = data.ce || data.chargeEfficiency || memory.chargeEfficiency
            memory.roomPerformance = data.rp || data.roomPerformance || {}
            memory.buildPerformance = data.bp || data.buildPerformance || memory.buildPerformance
            memory.history = data.h || data.history || []
            memory.enemyHistory = data.eh || data.enemyHistory || []
            memory.myMoveHistory = data.mm || data.myMoveHistory || []

            const compactMd = data.md || data.moveDetails || []
            memory.moveDetails = compactMd.map(r => ({
                timestamp: r.t || r.timestamp,
                move: r.m || r.move,
                enemyMove: r.e || r.enemyMove,
                result: r.r || r.result,
                build: r.b || r.build,
                room: r.n || r.room,
                method: r.x || r.method
            }))

            const totalStats = data.ts || data.totalStats || {}
            stats.win = totalStats.win || 0
            stats.lose = totalStats.lose || 0
            stats.total = totalStats.total || 0
            stats.draws = totalStats.draws || 0
            memory.sessionStats.totalSessions++
            console.log(`[Acc ${accountId}] Loaded history: ${memory.moveDetails.length} games, ${memory.sessionStats.totalWins} wins, ${memory.sessionStats.totalLosses} losses`)
            console.log(`[Acc ${accountId}] Overall winrate: ${getGlobalWinrate(memory)}%`)
            console.log(`[Acc ${accountId}] Best win streak: ${memory.sessionStats.bestWinStreak}, Worst loss streak: ${memory.sessionStats.worstLossStreak}`)
        }
    } catch (err) {
        console.log(`[Acc ${accountId}] Failed to load history:`, err.message)
    }
}

function saveHistory(memory, stats, historyFile) {
    try {
        if (memory.moveDetails.length > 200) memory.moveDetails = memory.moveDetails.slice(-100)

        const compactDetails = memory.moveDetails.map(r => ({
            t: r.timestamp,
            m: r.move,
            e: r.enemyMove,
            r: r.result,
            b: r.build,
            n: r.room,
            x: r.method
        }))

        const data = {
            ss: memory.sessionStats,
            mp: memory.methodPerformance,
            ep: memory.enemyPatterns,
            ds: memory.dungeonStats,
            ce: memory.chargeEfficiency,
            rp: memory.roomPerformance,
            bp: memory.buildPerformance,
            h: memory.history.slice(-50),
            eh: memory.enemyHistory.slice(-50),
            mm: memory.myMoveHistory.slice(-50),
            md: compactDetails.slice(-100),
            ts: stats,
            ls: Date.now()
        }
        fs.writeFileSync(historyFile, JSON.stringify(data))
    } catch (err) {
        console.log("Failed to save history:", err.message)
    }
}

function recordDetailedGame(memory, stats, currentRun, move, enemyMove, result, method, historyFile) {
    const room = currentRun?.currentRoom || 0

    memory.moveDetails.push({
        timestamp: Date.now(),
        move,
        enemyMove,
        result,
        method,
        build: memory.build,
        room
    })
    memory.sessionStats.totalGames++
    if (result === 'win') memory.sessionStats.totalWins++
    if (result === 'lose') memory.sessionStats.totalLosses++

    memory.chargeEfficiency[move].used++
    if (result === 'win') memory.chargeEfficiency[move].won++

    const roomKey = `room_${room}`
    if (!memory.roomPerformance[roomKey]) {
        memory.roomPerformance[roomKey] = { win: 0, loss: 0, total: 0 }
    }
    memory.roomPerformance[roomKey].total++
    if (result === 'win') memory.roomPerformance[roomKey].win++
    if (result === 'lose') memory.roomPerformance[roomKey].loss++

    const dungeonType = currentRun?.dungeon?.type || 'unknown'
    if (!memory.dungeonStats[dungeonType]) {
        memory.dungeonStats[dungeonType] = { win: 0, loss: 0, total: 0 }
    }
    memory.dungeonStats[dungeonType].total++
    if (result === 'win') memory.dungeonStats[dungeonType].win++
    if (result === 'lose') memory.dungeonStats[dungeonType].loss++

    memory.buildPerformance[memory.build].total++
    if (result === 'win') memory.buildPerformance[memory.build].win++
    if (result === 'lose') memory.buildPerformance[memory.build].loss++

    saveHistory(memory, stats, historyFile)
}

function getGlobalWinrate(memory) {
    const { totalWins, totalLosses } = memory.sessionStats
    const total = totalWins + totalLosses
    return total === 0 ? 0 : ((totalWins / total) * 100).toFixed(2)
}

function getBuildWinrate(memory, build) {
    const perf = memory.buildPerformance[build]
    if (!perf || perf.total === 0) return 0
    return ((perf.win / perf.total) * 100).toFixed(2)
}

function getChargeWinrate(memory, move) {
    const eff = memory.chargeEfficiency[move]
    if (!eff || eff.used === 0) return 0
    return ((eff.won / eff.used) * 100).toFixed(2)
}

function getBestBuild(memory) {
    const builds = Object.entries(memory.buildPerformance)
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

function chooseMove(memory, currentRun) {
    const player = currentRun.players[0]
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
    const threshold = getDynamicThreshold(memory)
    const entropy = calculateEntropy(memory)

    // PRIORITY 1: MIRROR STRATEGIES (high confidence when detected)
    const mirrorPred = detectMirror(memory)
    if (mirrorPred && memory.mirrorConfidence >= 0.75) {
        const c = counter(mirrorPred)
        if (available.includes(c)) {
            predictions.push({ method: "antimirror", move: c, confidence: 0.9 * memory.mirrorConfidence, pred: mirrorPred })
        }
    }

    // PRIORITY 2: N-GRAM PATTERN (length 2-5) - highest base confidence
    for (let len = 6; len >= 2; len--) {
        const pred = predictByNgram(memory, len)
        if (pred) {
            const c = counter(pred)
            if (available.includes(c)) {
                predictions.push({ method: "ngram", move: c, confidence: 0.75 + len * 0.04, pred })
            }
        }
    }

    // PRIORITY 3: STREAK DETECTION (exploits repetition bias)
    const streakPred = detectStreak(memory)
    if (streakPred) {
        const c = counter(streakPred)
        if (available.includes(c)) {
            predictions.push({ method: "streak", move: c, confidence: 0.88, pred: streakPred })
        }
    }

    // PRIORITY 4: ROTATION DETECTION (rock→paper→scissor cycle)
    const rotation = detectRotation(memory)
    if (rotation) {
        const c = counter(rotation)
        if (available.includes(c)) {
            predictions.push({ method: "pattern", move: c, confidence: 0.82, pred: rotation })
        }
    }

    // PRIORITY 4b: ALTERNATING PATTERN (A-B-A-B)
    const alternating = detectAlternating(memory)
    if (alternating) {
        const c = counter(alternating)
        if (available.includes(c)) {
            predictions.push({ method: "pattern", move: c, confidence: 0.8, pred: alternating })
        }
    }

    // PRIORITY 5: COUNTER-ROTATION (opponent trying to counter us)
    const counterRot = detectCounterRotation(memory)
    if (counterRot) {
        const c = counter(counterRot)
        if (available.includes(c)) {
            predictions.push({ method: "counterrot", move: c, confidence: 0.78, pred: counterRot })
        }
    }

    // PRIORITY 6: 2ND-ORDER MARKOV (context: last 2 moves)
    const markov2 = predictMarkovOrder(memory, 2)
    if (markov2) {
        const c = counter(markov2)
        if (available.includes(c)) {
            predictions.push({ method: "markov2", move: c, confidence: 0.72, pred: markov2 })
        }
    }

    // PRIORITY 7: TRANSITION PATTERN (how opponent responds to win/loss)
    const transition = predictTransition(memory)
    if (transition) {
        const c = counter(transition)
        if (available.includes(c)) {
            predictions.push({ method: "transition", move: c, confidence: 0.68, pred: transition })
        }
    }

    // PRIORITY 8: DOUBLE-THINK (level 2 reasoning)
    const doubleThink = predictDoubleThink(memory)
    if (doubleThink) {
        const c = counter(doubleThink)
        if (available.includes(c)) {
            predictions.push({ method: "doublethink", move: c, confidence: 0.7, pred: doubleThink })
        }
    }

    // PRIORITY 8b: LEVEL-3 THINKING (for advanced opponents)
    const level3 = predictLevel3(memory)
    if (level3) {
        const c = counter(level3)
        if (available.includes(c)) {
            predictions.push({ method: "doublethink", move: c, confidence: 0.6, pred: level3 })
        }
    }

    // PRIORITY 9: BAYESIAN PREDICTION
    const bayesian = predictBayesian(memory)
    if (bayesian) {
        const c = counter(bayesian)
        if (available.includes(c)) {
            predictions.push({ method: "bayesian", move: c, confidence: 0.62, pred: bayesian })
        }
    }

    // PRIORITY 10: 1ST-ORDER MARKOV
    const markov1 = predictMarkovOrder(memory, 1)
    if (markov1) {
        const c = counter(markov1)
        if (available.includes(c)) {
            predictions.push({ method: "markov1", move: c, confidence: 0.6, pred: markov1 })
        }
    }

    // PRIORITY 11: EXPLOITATIVE
    const exploitative = predictExploitative(memory)
    if (exploitative) {
        const c = counter(exploitative)
        if (available.includes(c)) {
            predictions.push({ method: "exploitative", move: c, confidence: 0.58, pred: exploitative })
        }
    }

    // PRIORITY 12: FREQUENCY
    const freq = predictByFrequencyExp(memory)
    if (freq) {
        const c = counter(freq)
        if (available.includes(c)) {
            predictions.push({ method: "frequency", move: c, confidence: 0.55, pred: freq })
        }
    }

    // Select best prediction using performance-weighted voting with recency bias
    if (predictions.length > 0) {
        const scored = predictions.map(p => {
            const perf = memory.methodPerformance[p.method]
            const totalGames = perf.win + perf.loss

            const perfRate = totalGames === 0 ? 0.5 : (perf.win + 1) / (totalGames + 2)
            const sampleWeight = Math.min(totalGames / 15, 1)
            const recencyBonus = (perf.win > perf.loss && totalGames > 3) ? 0.05 : 0
            const entropyBoost = entropy < 0.5 ? 0.08 : 0

            const adjustedConfidence = p.confidence * (0.6 + 0.4 * perfRate * sampleWeight) + recencyBonus + entropyBoost

            return { ...p, score: adjustedConfidence }
        })

        scored.sort((a, b) => b.score - a.score)
        const best = scored[0]

        const moveCounts = {}
        scored.forEach(p => {
            moveCounts[p.move] = (moveCounts[p.move] || 0) + p.score
        })

        const consensusMove = Object.entries(moveCounts)
            .sort(([, a], [, b]) => b - a)[0]

        const hasConsensus = consensusMove &&
            (moveCounts[consensusMove[0]] / scored.reduce((sum, p) => sum + p.score, 0)) > 0.6

        const finalMove = hasConsensus ? consensusMove[0] : best.move
        const finalScore = hasConsensus ? Math.max(best.score, 0.75) : best.score

        if (finalScore > threshold) {
            memory.lastMethod = best.method
            memory.patternConfidence = finalScore
            const consensusTag = hasConsensus ? " [CONSENSUS]" : ""
            console.log(`AI ${best.method.toUpperCase()}${consensusTag} → counter ${best.pred} (conf: ${finalScore.toFixed(2)}, thresh: ${threshold.toFixed(2)})`)
            return finalMove
        }
    }

    // SMART FALLBACK: Regret minimization strategy
    const h = memory.enemyHistory
    if (h.length > 0) {
        const counts = { rock: 0, paper: 0, scissor: 0 }
        h.forEach(m => counts[m]++)

        let bestMove = available[0]
        let bestScore = -Infinity

        available.forEach(move => {
            const beats = counter(counter(move))
            const losesTo = counter(move)
            const winProb = (counts[beats] || 0) / h.length
            const loseProb = (counts[losesTo] || 0) / h.length
            const drawProb = (counts[move] || 0) / h.length

            const expectedScore = winProb * 1 + drawProb * 0 + loseProb * (-1)

            const chargeBonus = move === "rock" ? (rock > paper ? 0.02 : 0) :
                move === "paper" ? (paper > scissor ? 0.02 : 0) :
                    (scissor > rock ? 0.02 : 0)

            const totalScore = expectedScore + chargeBonus

            if (totalScore > bestScore) {
                bestScore = totalScore
                bestMove = move
            }
        })

        if (bestScore > -0.3) {
            memory.lastMethod = "random"
            console.log(`AI FALLBACK → regret min: ${bestMove} (score: ${bestScore.toFixed(2)})`)
            return bestMove
        }
    }

    memory.lastMethod = "random"
    return available[Math.floor(Math.random() * available.length)]
}

function smartLootIndex(memory, currentRun) {

    updateBuild(memory)

    const options = currentRun.lootOptions || []
    const myHP = currentRun?.players?.[0]?.health?.current ?? 0
    const room = currentRun.currentRoom || 1

    let bestIndex = 0
    let bestScore = -9999

    options.forEach((opt, i) => {

        let score = 0
        const type = opt.boonTypeString?.toLowerCase() || ""

        score += (opt.RARITY_CID || 0) * 50

        if (room <= 4) score += 50
        if (room >= 10) score += 30

        if (type.includes("heal")) {
            if (myHP < 20) score += 1000
            else if (room >= 10) score += 200
            else score += 50
        }

        if (type.includes("maxhealth")) {
            score -= 400
        }

        if (type.includes("maxarmor")) {
            score += 350
            if (room >= 10) score += 200
        }

        if (type.includes("upgraderock")) {
            score += 200 + (opt.selectedVal1 || 0) * 50
            if (memory.build === "rock") score += 300
        }

        if (type.includes("upgradepaper")) {
            score += 180 + (opt.selectedVal1 || 0) * 40
            if (memory.build === "paper") score += 300
        }

        if (type.includes("upgradescissor")) {
            score += 150 + (opt.selectedVal1 || 0) * 30
            if (memory.build === "scissor") score += 300
        }

        if (memory.build === "balanced") {
            score += 50
        }

        score += Math.random() * 15

        console.log(`Option ${i}: ${opt.boonTypeString} → score: ${score}`)

        if (score > bestScore) {
            bestScore = score
            bestIndex = i
        }

    })

    console.log("AI BUILD:", memory.build)
    console.log("Chosen index:", bestIndex)

    return bestIndex
}

function updateBuild(memory) {
    const recent = memory.history.slice(-10)
    const loseCount = recent.filter(x => x === "lose").length
    const winCount = recent.filter(x => x === "win").length
    const recentRate = getRecentWinRate(memory, 10)

    const bestBuild = getBestBuild(memory)
    const currentBuildWinrate = getBuildWinrate(memory, memory.build)
    const bestBuildWinrate = getBuildWinrate(memory, bestBuild)

    if (memory.sessionStats.totalGames > 50 && bestBuild !== memory.build && bestBuildWinrate > currentBuildWinrate + 5) {
        console.log(`AI HISTORICAL OPTIMIZE → switch from ${memory.build}(${currentBuildWinrate}%) to ${bestBuild}(${bestBuildWinrate}%)`)
        console.log("Build winrates:", {
            balanced: getBuildWinrate(memory, 'balanced') + "%",
            rock: getBuildWinrate(memory, 'rock') + "%",
            paper: getBuildWinrate(memory, 'paper') + "%",
            scissor: getBuildWinrate(memory, 'scissor') + "%"
        })
        memory.build = bestBuild
        return
    }

    if (memory.consecutiveLosses >= 2) {
        const builds = ["rock", "paper", "scissor"]
        const currentIdx = builds.indexOf(memory.build)
        memory.build = builds[(currentIdx + 2) % 3]
        memory.consecutiveLosses = 0
        console.log("AI CRITICAL ADAPT → switch build to", memory.build, "(2 losses)")
        return
    }

    if (loseCount >= 3 && winCount <= 1) {
        const builds = ["rock", "paper", "scissor"]
        const currentIdx = builds.indexOf(memory.build)
        memory.build = builds[(currentIdx + 1) % 3]
        console.log("AI EMERGENCY ADAPT → switch build to", memory.build, "(3/5 losses)")
        return
    }

    if (recentRate < 45 && loseCount >= 3) {
        const builds = ["rock", "paper", "scissor"]
        const currentIdx = builds.indexOf(memory.build)
        memory.build = builds[(currentIdx + 1) % 3]
        console.log("AI ADAPT → switch build to", memory.build, "(poor winrate)")
    }

    if (memory.winStreak >= 4) {
        console.log("AI REINFORCE → keep build", memory.build, "(win streak:", memory.winStreak, ")")
    }

    const h = memory.enemyHistory
    if (h.length > 10) {
        const counts = { rock: 0, paper: 0, scissor: 0 }
        h.forEach(m => counts[m]++)
        const fav = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b)
        const favPct = counts[fav] / h.length

        if (favPct > 0.4 && memory.build === "balanced") {
            memory.build = counter(fav)
            console.log("AI ENTROPY ADAPT → counter enemy favorite", fav)
        }
    }
}

// ========== ADVANCED PREDICTION ALGORITHMS ==========

// N-GRAM: Detect repeating sequences of length n
function predictByNgram(memory, n) {
    const h = memory.enemyHistory
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
function detectStreak(memory) {
    const h = memory.enemyHistory
    if (h.length < 3) return null

    const last3 = h.slice(-3)
    if (last3[0] === last3[1] && last3[1] === last3[2]) {
        return last3[2] // likely to continue streak (gambler's fallacy bias)
    }

    // Also check for 2-streak with increasing probability
    if (last3[1] === last3[2]) {
        // Some players alternate after 2, some continue
        // Return the streak move - statistically more likely to continue
        return last3[2]
    }

    return null
}

// MARKOV ORDER N: Higher-order Markov chain
function predictMarkovOrder(memory, order) {
    const h = memory.enemyHistory
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
function detectRotation(memory) {
    const h = memory.enemyHistory
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
function predictExploitative(memory) {
    const myLast = memory.myMoveHistory.slice(-1)[0]
    if (!myLast) return null

    // If enemy is countering us, they play what beats our last move
    // So we play what beats that
    const whatBeatsMyLast = counter(myLast)
    return whatBeatsMyLast
}

// FREQUENCY with exponential decay
function predictByFrequencyExp(memory) {
    const h = memory.enemyHistory
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

// ========== ADVANCED PREDICTION ALGORITHMS V2 ==========

// DOUBLE-THINK: Predict what opponent predicts we'll play
// If we've been winning, opponent might try to counter our last move
function predictDoubleThink(memory) {
    const myLast = memory.myMoveHistory.slice(-1)[0]
    if (!myLast) return null

    // If we're on a win streak, opponent likely tries to counter our last move
    if (memory.winStreak >= 2) {
        // Opponent will play what beats our last move (counter(myLast))
        // We return what opponent will play, and let chooseMove counter it
        return counter(myLast)
    }

    // If we just lost, opponent might repeat their winning move
    // We should counter their last move (handled by other strategies)
    return null
}

// LEVEL-3 THINKING: Counter the double-think (for advanced opponents)
function predictLevel3(memory) {
    const myLast = memory.myMoveHistory.slice(-1)[0]
    const h = memory.enemyHistory
    if (!myLast || h.length < 5) return null

    // Check if opponent is a level-2 thinker (adapts to our patterns)
    // They might expect us to change after a win streak
    if (memory.winStreak >= 3) {
        // After a long win streak, opponent expects us to change
        // They'll play what beats what would beat our last move
        // So we play our last move again (they won't expect it)
        return counter(counter(myLast)) // what we'd play if we changed
    }

    return null
}

// MIRROR DETECTION: Detect if opponent mirrors our moves
function detectMirror(memory) {
    const h = memory.enemyHistory
    const myH = memory.myMoveHistory
    if (h.length < 4 || myH.length < 4) return null

    // Check if opponent played same as our previous move
    let mirrorCount = 0
    for (let i = 1; i <= 4; i++) {
        if (h[h.length - i] === myH[myH.length - i - 1]) {
            mirrorCount++
        }
    }

    memory.isEnemyMirroring = mirrorCount >= 3
    memory.mirrorConfidence = mirrorCount / 4

    if (memory.isEnemyMirroring) {
        // If opponent mirrors our last move, they'll play what we played
        // So we should play what beats our own last move
        const myLast = myH[myH.length - 1]
        return myLast // they'll mirror this, so we counter it
    }

    return null
}

// ANTI-MIRROR: Counter the mirror strategy
function predictAntiMirror(memory) {
    if (!memory.isEnemyMirroring) return null

    const myLast = memory.myMoveHistory.slice(-1)[0]
    if (!myLast) return null

    // If opponent mirrors our moves, play what beats our own last move
    return counter(myLast)
}

// COUNTER-ROTATION: Detect if opponent is cycling to counter us
function detectCounterRotation(memory) {
    const h = memory.enemyHistory
    const myH = memory.myMoveHistory
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
function detectAlternating(memory) {
    const h = memory.enemyHistory
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
function predictTransition(memory) {
    const h = memory.enemyHistory
    const outcomes = memory.history
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

// BAYESIAN PREDICTION: Update beliefs based on observations
function predictBayesian(memory) {
    const h = memory.enemyHistory
    if (h.length < 3) return null

    // Update Dirichlet distribution
    memory.bayesianStats = {
        rock: { alpha: 1, beta: 1 },
        paper: { alpha: 1, beta: 1 },
        scissor: { alpha: 1, beta: 1 }
    }

    h.forEach(move => {
        memory.bayesianStats[move].alpha++
    })

    // Calculate expected probabilities
    const total = h.length + 3 // prior pseudo-counts
    const probs = {
        rock: memory.bayesianStats.rock.alpha / total,
        paper: memory.bayesianStats.paper.alpha / total,
        scissor: memory.bayesianStats.scissor.alpha / total
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
function calculateEntropy(memory) {
    const h = memory.enemyHistory
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
function getDynamicThreshold(memory) {
    const recentRate = parseFloat(getRecentWinRate(memory, 15))
    const entropy = calculateEntropy(memory)

    let baseThreshold = 0.5

    if (recentRate < 40) {
        baseThreshold = 0.35
    } else if (recentRate > 60) {
        baseThreshold = 0.55
    }

    if (entropy > 0.8) {
        baseThreshold -= 0.1
    }

    memory.dynamicThreshold = Math.max(0.3, Math.min(0.6, baseThreshold))
    return memory.dynamicThreshold
}

// Legacy compatibility functions (for single account use)
function predictEnemyAdvanced(memory) {
    return predictMarkovOrder(memory, 1)
}

function predictByFrequency(memory) {
    return predictByFrequencyExp(memory)
}

function detectPattern(memory) {
    return predictByNgram(memory, 3)
}

function antiCounter(memory) {
    const exploitative = predictExploitative(memory)
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

// ================= BOT CLASS =================
class Bot {
    constructor(account) {
        this.id = account.id
        this.token = account.token
        this.address = account.address

        this.headers = {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
            origin: "https://gigaverse.io",
            referer: "https://gigaverse.io/play"
        }

        this.actionToken = ""
        this.dungeonId = 1
        this.run = null
        this.events = null
        this.memory = createAIMemory()
        this.stats = createStats()
        this.logFiles = getLogFiles(this.id)

        this.running = false
    }

    log(...args) {
        console.log(`[Acc ${this.id}]`, ...args)
    }

    async sendAction(action, index = 0, retry = 0) {
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

            return data
        } catch (err) {
            const data = err.response?.data

            if (data?.actionToken) {
                this.actionToken = data.actionToken
            }

            if (retry < 3) {
                this.log("Retry request...")
                await sleep(3000)
                return this.sendAction(action, index, retry + 1)
            }

            this.log("Request error:", data?.message || err.message)
            return null
        }
    }

    async getEnergy() {
        try {
            const url = `https://gigaverse.io/api/offchain/player/energy/${this.address}`
            const res = await axios.get(url, { headers: this.headers })
            const energy = res.data?.entities?.[0]?.parsedData?.energyValue ?? 0
            this.log("Current Energy:", energy)
            return energy
        } catch (err) {
            this.log("Get energy error:", err.message)
            return 0
        }
    }

    async startDungeon() {
        this.log("===== CHECK ENERGY =====")

        const energy = await this.getEnergy()

        if (energy < 40) {
            this.log("Not enough energy, skipping...")
            return false
        }

        this.log("===== START NEW DUNGEON =====")

        this.actionToken = ""
        this.dungeonId = 1

        const res = await this.sendAction("start_run")

        if (res?.data?.run) {
            this.run = res.data.run
        }

        await sleep(8000)
        return true
    }

    async doLoot() {
        if (!this.run?.lootOptions) return

        this.log("===== LOOT PHASE =====")

        const myHP = this.run?.players?.[0]?.health?.current ?? 0

        this.run.lootOptions.forEach((x, i) => {
            console.log(`[Acc ${this.id}] ${i}: ${x.boonTypeString}`)
        })

        let index = smartLootIndex(this.memory, this.run)

        if (myHP < 10) {
            const healIndex = this.run.lootOptions.findIndex(
                x => x.boonTypeString?.toLowerCase().includes("heal")
            )
            if (healIndex !== -1) {
                index = healIndex
                this.log("Low HP → picking HEAL")
            }
        }

        await this.sendAction("loot_one", index)
        await sleep(4000)
    }

    async runLoop() {
        this.running = true
        this.log("BOT STARTED")

        loadHistory(this.memory, this.stats, this.logFiles.history, this.id)

        const started = await this.startDungeon()
        if (!started) {
            this.log("Failed to start dungeon, waiting...")
            await sleep(60000)
            this.running = false
            return
        }

        while (this.running) {
            if (!this.run) {
                const energy = await this.getEnergy()
                if (energy < 40) {
                    this.log("Idle → waiting energy")
                    await sleep(60000)
                    break
                }
                this.log("Waiting for run data")
                await sleep(3000)
                continue
            }

            if (this.run.lootPhase) {
                await this.doLoot()
                continue
            }

            const move = chooseMove(this.memory, this.run)

            if (!move) {
                this.log("No charges → restart dungeon")
                const started = await this.startDungeon()
                if (!started) break
                continue
            }

            this.memory.myMoveHistory.push(move)
            if (this.memory.myMoveHistory.length > 30) this.memory.myMoveHistory.shift()

            await this.sendAction(move)

            const myMove = this.events[0]?.value
            const enemyMove = this.events[1]?.value

            this.log("Enemy move:", enemyMove, "| Bot move:", myMove)

            if (myMove && enemyMove) {
                const result = judgeResult(myMove, enemyMove)
                this.memory.lastResult = result
                updateMethodPerformance(this.memory, result)

                if (result === "draw") {
                    this.stats.draws++
                } else if (result) {
                    this.stats.total++
                    if (result === "win") this.stats.win++
                    if (result === "lose") this.stats.lose++
                    this.memory.history.push(result)
                    if (this.memory.history.length > 50) this.memory.history.shift()
                }
                this.log("RESULT:", result, "| Method:", this.memory.lastMethod, "| Streak:", this.memory.winStreak)
                recordDetailedGame(this.memory, this.stats, this.run, myMove, enemyMove, result, this.memory.lastMethod, this.logFiles.history)
            }

            this.log({
                globalWinrate: getGlobalWinrate(this.memory) + "%",
                result: this.memory.lastResult,
                winrate: getWinRate(this.stats),
                recentWinrate: getRecentWinRate(this.memory, 10),
                bestMethod: getBestMethod(this.memory),
                confidence: this.memory.patternConfidence.toFixed(2),
                threshold: this.memory.dynamicThreshold.toFixed(2),
                entropy: calculateEntropy(this.memory).toFixed(2),
                mirror: this.memory.isEnemyMirroring ? "YES" : "NO"
            })

            if (enemyMove) {
                this.memory.enemyHistory.push(enemyMove)
                if (this.memory.enemyHistory.length > 50) {
                    this.memory.enemyHistory.shift()
                }
            }

            const enemyHP = this.run?.players[1]?.health?.current ?? 0
            const myHP = this.run?.players[0]?.health?.current ?? 0
            this.log("enemyHP:", enemyHP, "| myHP:", myHP)
            this.log("EnemyHistory:", this.memory.enemyHistory.slice(-20).join("→"))

            if (this.memory.sessionStats.totalGames % 10 === 0 && this.memory.sessionStats.totalGames > 0) {
                this.log("\n===== PERIODIC STATS REPORT =====")
                this.log(`Total Games: ${this.memory.sessionStats.totalGames}`)
                this.log(`Global Winrate: ${getGlobalWinrate(this.memory)}%`)
                this.log(`Current Session: ${this.stats.win}W / ${this.stats.lose}L (${getWinRate(this.stats)}%)`)
                this.log(`Best Win Streak: ${this.memory.sessionStats.bestWinStreak}`)
                this.log(`Worst Loss Streak: ${this.memory.sessionStats.worstLossStreak}`)
                this.log(`Best Build: ${getBestBuild(this.memory)} (${getBuildWinrate(this.memory, getBestBuild(this.memory))}%)`)
                this.log(`Best Method: ${getBestMethod(this.memory)}`)
                this.log("=================================\n")
            }

            if (enemyHP <= 0) {
                this.log("Enemy defeated")
                await sleep(6000)
                continue
            }

            if (myHP <= 0) {
                this.log("Player died")
                const started = await this.startDungeon()
                if (!started) break
                continue
            }

            const d = randomDelay()
            this.log("Next move:", d / 1000, "seconds")
            await sleep(d)

            if (!this.run?.players || !this.run.players[1]) {
                this.log("Invalid run → restart")
                const started = await this.startDungeon()
                if (!started) break
                continue
            }
        }

        this.running = false
        this.log("Bot stopped")
    }

    stop() {
        this.running = false
    }
}

// ================= MULTI-ACCOUNT RUNNER =================
async function runMultiAccount() {
    const bots = ACCOUNTS.map(acc => new Bot(acc))

    console.log(`\n========== STARTING ${bots.length} BOT(S) ==========\n`)

    // Run all bots concurrently
    await Promise.all(bots.map(bot => bot.runLoop().catch(err => {
        console.error(`[Acc ${bot.id}] Fatal error:`, err.message)
    })))

    console.log("\n========== ALL BOTS STOPPED ==========\n")
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log("\nReceived SIGINT, stopping bots...")
    process.exit(0)
})

process.on('SIGTERM', () => {
    console.log("\nReceived SIGTERM, stopping bots...")
    process.exit(0)
})

// Start multi-account runner
runMultiAccount()