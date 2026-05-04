/**
 * Intelligent Chainers Missions System
 * Proactively detects, plans, and executes mission tasks
 */

import {
    MISSIONS_API,
    EVENT_CODES,
    TASK_TYPES,
    getCompleteMissionStatus,
    claimTaskReward,
    claimAllAvailableRewards,
    useFertilizer,
} from "./missions.js";

// ==================== INTELLIGENT MISSION TRACKER ====================

class MissionIntelligence {
    constructor() {
        this.cachedStatus = null;
        this.inventorySnapshot = null;
        this.actionQueue = [];
        this.lastActionAt = 0;
        this.actionCooldown = 2000; // 2s between actions
        this.completedTasks = new Set();
        this.failedTasks = new Set();
    }

    /**
     * Analyze mission status and create action plan
     */
    analyze(context, missionStatus, inventory) {
        this.cachedStatus = missionStatus;
        this.inventorySnapshot = inventory;
        this.actionQueue = [];

        if (!missionStatus?.events) return [];

        const actionableTasks = [];

        for (const event of missionStatus.events) {
            for (const task of event.tasks) {
                if (task.isCompleted) continue;
                if (this.completedTasks.has(task.taskId)) continue;

                const canComplete = this.canCompleteTask(task, inventory);
                const priority = this.calculatePriority(task, canComplete);
                const remaining = (task.repeatsNeeded || 1) - (task.currentProgress || 0);

                actionableTasks.push({
                    ...task,
                    eventCode: event.code,
                    eventType: event.type,
                    canCompleteNow: canComplete,
                    priority,
                    remaining,
                    actionPlan: this.createActionPlan(task, inventory),
                });
            }
        }

        // Sort by priority (higher first) and completion ability
        actionableTasks.sort((a, b) => {
            if (a.canCompleteNow !== b.canCompleteNow) {
                return a.canCompleteNow ? -1 : 1; // Completable first
            }
            return b.priority - a.priority;
        });

        this.actionQueue = actionableTasks;
        return actionableTasks;
    }

    /**
     * Check if task can be completed with current inventory/state
     */
    canCompleteTask(task, inventory) {
        const inv = inventory || {};

        switch (task.type) {
            case TASK_TYPES.REWARD_POOL_ANY:
                // Check if we have vegetables to deposit
                return (inv.vegetables?.length > 0) || (inv.seeds?.length > 0);

            case TASK_TYPES.FERTILIZER_USED:
            case "fertilizer_used":
                // Check if we have fertilizer
                return inv.fertilizers?.length > 0;

            case TASK_TYPES.HARVEST_SPECIAL_SEED:
            case "harvest_special_seed":
                // Check if we have special seeds planted or in inventory
                return inv.specialSeeds?.length > 0 || inv.plantedSpecial?.length > 0;

            case TASK_TYPES.PLANT_SEED:
            case "plant_seed":
            case "plant_special_seed":
                // Check if we have seeds and empty plots
                return inv.seeds?.length > 0 && inv.emptyPlots > 0;

            case TASK_TYPES.DAILY_REWARD:
            case "daily_reward":
                // Daily reward is always claimable once per day
                return true;

            case TASK_TYPES.REWARD_POOL_BP:
            case "bp_any_reward_pool":
                // BP tasks - just need to interact with pool
                return true;

            case TASK_TYPES.SPECIAL_CRAFTING:
            case "special_crafting":
                // Check crafting materials
                return inv.craftingMaterials?.length >= (task.repeatsNeeded - (task.currentProgress || 0));

            default:
                // Unknown tasks - assume possible
                return task.isAvailable;
        }
    }

    /**
     * Calculate task priority score
     */
    calculatePriority(task, canComplete) {
        let score = 0;

        // Base priority by task type
        const typePriority = {
            [TASK_TYPES.DAILY_REWARD]: 100,
            [TASK_TYPES.REWARD_POOL_ANY]: 90,
            [TASK_TYPES.FERTILIZER_USED]: 80,
            [TASK_TYPES.HARVEST_SPECIAL_SEED]: 70,
            [TASK_TYPES.PLANT_SEED]: 60,
            [TASK_TYPES.DAILY_TASK_COMPLETED]: 50,
        };

        score += typePriority[task.type] || 30;

        // Boost if can complete now
        if (canComplete) score += 50;

        // Boost by progress percentage (nearly done = higher priority)
        const progress = task.currentProgress || 0;
        const needed = task.repeatsNeeded || 1;
        const percentDone = progress / needed;
        score += percentDone * 20;

        // Daily tasks get time-based boost (do early in day)
        if (task.type?.includes("daily")) {
            const hour = new Date().getHours();
            if (hour < 12) score += 10; // Morning boost
        }

        return score;
    }

    /**
     * Create specific action plan for task
     */
    createActionPlan(task, inventory) {
        const inv = inventory || {};
        const remaining = (task.repeatsNeeded || 1) - (task.currentProgress || 0);

        switch (task.type) {
            case TASK_TYPES.REWARD_POOL_ANY:
                return {
                    type: "deposit_to_pool",
                    targetCount: remaining,
                    availableItems: inv.vegetables?.length || 0,
                };

            case TASK_TYPES.FERTILIZER_USED:
            case "fertilizer_used":
                return {
                    type: "use_fertilizer",
                    targetCount: remaining,
                    availableFertilizers: inv.fertilizers || [],
                    targetPlots: inv.plantedCrops?.filter(c => !c.hasFertilizer) || [],
                };

            case TASK_TYPES.HARVEST_SPECIAL_SEED:
            case "harvest_special_seed":
                return {
                    type: "harvest_special",
                    targetCount: remaining,
                    readyToHarvest: inv.plantedSpecial?.filter(c => c.isReady) || [],
                    needsPlanting: inv.specialSeeds || [],
                };

            case TASK_TYPES.PLANT_SEED:
            case "plant_seed":
                return {
                    type: "plant_seeds",
                    targetCount: Math.min(remaining, inv.emptyPlots || 0),
                    availableSeeds: inv.seeds || [],
                    emptyPlots: inv.emptyPlots || 0,
                };

            case TASK_TYPES.SPECIAL_CRAFTING:
            case "special_crafting":
                return {
                    type: "craft",
                    targetCount: remaining,
                    materialsNeeded: task.repeatsNeeded - (task.currentProgress || 0),
                };

            default:
                return { type: "unknown", note: "No specific action plan" };
        }
    }

    /**
     * Get next immediate action to execute
     */
    getNextAction() {
        const now = Date.now();
        if (now - this.lastActionAt < this.actionCooldown) return null;

        const action = this.actionQueue.find(a =>
            a.canCompleteNow &&
            !this.completedTasks.has(a.taskId) &&
            !this.failedTasks.has(a.taskId)
        );

        return action || null;
    }

    /**
     * Mark task as completed
     */
    markCompleted(taskId) {
        this.completedTasks.add(taskId);
        this.lastActionAt = Date.now();
    }

    /**
     * Mark task as failed (temporarily)
     */
    markFailed(taskId) {
        this.failedTasks.add(taskId);
        this.lastActionAt = Date.now();
    }

    /**
     * Reset failed tasks (retry on next cycle)
     */
    resetFailures() {
        this.failedTasks.clear();
    }

    /**
     * Get mission completion summary
     */
    getSummary() {
        return {
            queueLength: this.actionQueue.length,
            completableNow: this.actionQueue.filter(a => a.canCompleteNow).length,
            completed: this.completedTasks.size,
            failed: this.failedTasks.size,
        };
    }
}

// ==================== SMART MISSION EXECUTOR ====================

/**
 * Execute intelligent mission actions
 * Returns detailed results
 */
async function executeSmartMissions(context, missionStatus, inventory, chainersHeaders) {
    const results = {
        analyzed: 0,
        queued: 0,
        attempted: [],
        succeeded: [],
        failed: [],
        skipped: [],
    };

    if (!missionStatus?.events || !chainersHeaders) {
        return results;
    }

    // Initialize or get mission intelligence
    if (!context.missionIntel) {
        context.missionIntel = new MissionIntelligence();
    }

    const intel = context.missionIntel;

    // Analyze and create action queue
    const actionable = intel.analyze(context, missionStatus, inventory);
    results.analyzed = actionable.length;
    results.queued = actionable.filter(a => a.canCompleteNow).length;

    if (actionable.length === 0) {
        console.log("📋 No actionable missions at this time");
        return results;
    }

    // Show mission plan
    console.log(`\n🎯 MISSION PLAN: ${actionable.filter(a => a.canCompleteNow).length}/${actionable.length} tasks completable now`);

    for (const task of actionable.slice(0, 5)) {
        const status = task.canCompleteNow ? "✅" : "⏳";
        const progress = `${task.currentProgress || 0}/${task.repeatsNeeded}`;
        console.log(`   ${status} [P${Math.round(task.priority)}] ${task.title} (${progress}) - ${task.actionPlan.type}`);
    }

    // Execute top priority completable task
    const nextAction = intel.getNextAction();
    if (!nextAction) {
        console.log("   ⏳ Waiting for cooldown or resources...");
        return results;
    }

    console.log(`\n🚀 EXECUTING: ${nextAction.title} (${nextAction.remaining} remaining)`);

    try {
        let actionResult = null;

        switch (nextAction.actionPlan.type) {
            case "use_fertilizer":
                actionResult = await executeFertilizerMission(context, nextAction, chainersHeaders);
                break;

            case "deposit_to_pool":
                // Signal to main loop to prioritize pool deposit
                context.missionSignal = { type: "prioritize_pool", count: nextAction.remaining };
                actionResult = { success: true, note: "Signaled main loop to deposit to pool" };
                break;

            case "harvest_special":
                // Signal to main loop to prioritize special seed harvest
                context.missionSignal = { type: "prioritize_harvest_special", count: nextAction.remaining };
                actionResult = { success: true, note: "Signaled main loop to harvest special seeds" };
                break;

            case "plant_seeds":
                // Signal to main loop to prioritize planting
                context.missionSignal = { type: "prioritize_planting", count: nextAction.remaining };
                actionResult = { success: true, note: "Signaled main loop to plant seeds" };
                break;

            default:
                results.skipped.push({ task: nextAction.title, reason: "No executor available" });
                console.log(`   ⏭️ Skipped: ${nextAction.title} - no executor`);
                return results;
        }

        if (actionResult?.success) {
            intel.markCompleted(nextAction.taskId);
            results.succeeded.push({
                taskId: nextAction.taskId,
                title: nextAction.title,
                result: actionResult,
            });
            console.log(`   ✅ SUCCESS: ${actionResult.message || actionResult.note || "Completed"}`);
        } else {
            intel.markFailed(nextAction.taskId);
            results.failed.push({
                taskId: nextAction.taskId,
                title: nextAction.title,
                error: actionResult?.error || "Unknown error",
            });
            console.log(`   ❌ FAILED: ${actionResult?.error || "Unknown error"}`);
        }

        results.attempted.push(nextAction.taskId);

    } catch (e) {
        intel.markFailed(nextAction.taskId);
        results.failed.push({
            taskId: nextAction.taskId,
            title: nextAction.title,
            error: e.message,
        });
        console.log(`   ❌ ERROR: ${e.message}`);
    }

    return results;
}

/**
 * Execute fertilizer mission specifically
 */
async function executeFertilizerMission(context, task, chainersHeaders) {
    const plan = task.actionPlan;

    if (!plan.availableFertilizers?.length) {
        return { success: false, error: "No fertilizers available" };
    }

    if (!plan.targetPlots?.length) {
        return { success: false, error: "No suitable plots to fertilize" };
    }

    const fertilizer = plan.availableFertilizers[0];
    const plot = plan.targetPlots[0];

    const result = await useFertilizer(
        context,
        chainersHeaders,
        plot.userFarmingID,
        fertilizer.itemID
    );

    return result;
}

/**
 * Create inventory snapshot for mission analysis
 */
function createInventorySnapshot(context) {
    // This should be called with actual inventory data from the bot
    return {
        vegetables: context.cachedVegetables || [],
        seeds: context.cachedFarmSeeds || [],
        fertilizers: context.cachedFarmSeeds?.filter(s => s.itemCode?.includes("fertilizer")) || [],
        specialSeeds: context.cachedFarmSeeds?.filter(s => s.itemCode?.includes("special")) || [],
        emptyPlots: context.lastGrowthAnalysis?.empty || 0,
        plantedCrops: context.lastGardensData?.gardens?.flatMap(g => g.userFarmings || []) || [],
        craftingMaterials: [], // TODO: Add when crafting data available
    };
}

/**
 * Check if missions are blocking and need immediate attention
 */
function checkMissionUrgency(missionStatus) {
    if (!missionStatus?.events) return { urgent: false, reason: null };

    const now = new Date();
    const hoursLeftToday = 24 - now.getHours();

    for (const event of missionStatus.events) {
        // Check if event ends soon
        if (event.endDate) {
            const endTime = new Date(event.endDate);
            const hoursLeft = (endTime - now) / (1000 * 60 * 60);

            if (hoursLeft < 24 && event.availableCount > 0) {
                return {
                    urgent: true,
                    reason: `${event.title} ends in ${Math.floor(hoursLeft)}h with ${event.availableCount} unclaimed rewards`,
                    eventCode: event.code,
                };
            }
        }

        // Check daily tasks in evening
        if (event.type === "daily" && hoursLeftToday < 4 && event.availableCount > 0) {
            return {
                urgent: true,
                reason: `Daily missions ending soon (${hoursLeftToday}h left) with ${event.availableCount} unclaimed`,
                eventCode: event.code,
            };
        }
    }

    return { urgent: false, reason: null };
}

// ==================== EXPORTS ====================

export {
    MissionIntelligence,
    executeSmartMissions,
    executeFertilizerMission,
    createInventorySnapshot,
    checkMissionUrgency,
};

export default {
    MissionIntelligence,
    executeSmartMissions,
    checkMissionUrgency,
};
