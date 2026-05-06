/**
 * Chainers Daily/Weekly/Monthly Missions Module
 * Extracted from chainers.io.har
 * 
 * Usage: import { fetchMissions, getTaskProgress, claimTaskReward } from './missions.js'
 */

// API Endpoints
const MISSIONS_API = {
    ACTIVE_EVENTS: "https://chainers.io/api/missions/data/active-events",
    USER_EVENTS_STATUS: "https://chainers.io/api/missions/user/user-events-status",
    TASKS_LIST: "https://chainers.io/api/missions/data/events-tasks-list",
    TASKS_REWARDS: "https://chainers.io/api/missions/data/events-tasks-rewards",
    TASKS_PROGRESS: "https://chainers.io/api/missions/user/tasks-progress",
    CLAIM_REWARD: "https://chainers.io/api/missions/control/claim-reward",
};

// Known event codes (from active events response)
const EVENT_CODES = {
    DAILY: "may2026_daily",      // Changes monthly: april2026_daily, may2026_daily, etc.
    WEEKLY: "may2026_weekly",    // Changes monthly
    MONTHLY: "may2026_monthly",   // Changes monthly
    TASK_WALL: "may2026_taskwall", // Weekly task wall
};

// Task types mapping (what each task requires)
const TASK_TYPES = {
    // Daily tasks
    DAILY_TASK_COMPLETED: "daily_task_completed",           // Complete daily missions (3x)
    REWARD_POOL_ANY: "reward_pool_any",                     // Collect rewards from any pool (6x)
    PHYTOLAMP_USED: "phytolamp_used",                       // Use Phytolamp on planted seed (3x)
    HARVEST_SPECIAL_SEED: "harvest_special_seed",         // Harvest special seeds (3x)
    SPECIAL_OFFERWALL_PAYMENT: "special_offerwall_payment", // Offerwall payment task

    // Weekly tasks (from task list)
    WEEKLY_LOGIN: "weekly_login",                           // Login X days
    WEEKLY_HARVEST_TOTAL: "weekly_harvest_total",          // Harvest total vegetables
    WEEKLY_PLANT_SEEDS: "weekly_plant_seeds",              // Plant seeds
    WEEKLY_USE_FERTILIZER: "weekly_use_fertilizer",        // Use fertilizer
    WEEKLY_COMPLETE_MISSIONS: "weekly_complete_missions",  // Complete missions
    WEEKLY_OFFERWALL_PAYMENT: "weekly_offerwall_payment",  // Offerwall payment

    // Monthly tasks
    MONTHLY_LOGIN: "monthly_login",
    MONTHLY_HARVEST_TOTAL: "monthly_harvest_total",
    MONTHLY_PLANT_SEEDS: "monthly_plant_seeds",
    MONTHLY_OFFERWALL_PAYMENT: "monthly_offerwall_payment",
};

// Reward codes (task rewards)
const REWARD_CODES = {
    // Daily rewards
    DAILY_1: "daily_1_23092025",           // Complete daily missions reward
    CFB_1: "CFB_1",                        // Phytolamp task reward (1 CFB)
    CFB_2: "CFB_2",                        // Reward pool task reward (2 CFB)
    COMMON_FERTILIZER_2: "common_fertilizer_2", // Harvest task reward

    // Weekly rewards
    WEEKLY_1: "weekly_1_23092025",        // Common reward
    WEEKLY_BONUS: "weekly_bonus_23092025", // Weekly bonus
    CFB_5: "CFB_5",
    CFB_7: "CFB_7",
    COMMON_FERTILIZER_5: "common_fertilizer_5",

    // Monthly rewards
    MONTHLY_6: "monthly_6_23092025",
    MONTHLY_7: "monthly_7_23092025",
    MONTHLY_BONUS: "monthly_bonus_23092025",
    CFB_10: "CFB_10",
    CFB_15: "CFB_15",
    COMMON_FERTILIZER_25: "common_fertilizer_25",
};

/**
 * Get current month event codes (auto-detects based on date)
 */
function getCurrentEventCodes() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.toLocaleString('en-US', { month: 'long' }).toLowerCase();
    const monthShort = now.toLocaleString('en-US', { month: 'short' }).toLowerCase();

    return {
        DAILY: `${month}${year}_daily`,
        WEEKLY: `${month}${year}_weekly`,
        MONTHLY: `${month}${year}_monthly`,
        TASK_WALL: `${month}${year}_taskwall`,
    };
}

/**
 * Parse task requirements from task data
 * Returns human-readable description and automation hints
 */
function parseTaskRequirements(task) {
    const requirements = {
        type: task.type,
        code: task.tasksCode || task.code,
        title: task.title?.en || task.title,
        repeatsNeeded: task.completeCountRepeats || 1,
        currentProgress: 0,
        isCompleted: false,
        automationHints: [],
    };

    // Add automation hints based on task type
    switch (task.type) {
        case TASK_TYPES.REWARD_POOL_ANY:
            requirements.automationHints.push("Auto: Use reward pool 6 times");
            break;
        case TASK_TYPES.PHYTOLAMP_USED:
            requirements.automationHints.push("Auto: Use phytolamp on 3 planted seeds");
            break;
        case TASK_TYPES.HARVEST_SPECIAL_SEED:
            requirements.automationHints.push("Auto: Harvest 3 special seeds");
            break;
        case TASK_TYPES.DAILY_TASK_COMPLETED:
            requirements.automationHints.push("Auto: Complete all other daily tasks first");
            break;
        default:
            if (task.type.includes("harvest")) {
                requirements.automationHints.push("Auto: Harvest crops");
            }
            if (task.type.includes("plant")) {
                requirements.automationHints.push("Auto: Plant seeds");
            }
            if (task.type.includes("fertilizer")) {
                requirements.automationHints.push("Auto: Use fertilizer");
            }
    }

    return requirements;
}

/**
 * Get default headers for API requests
 */
async function getHeaders(context, includeJson = false) {
    // Try to get headers from the bot's context if available
    if (context.chainersHeaders) {
        return await context.chainersHeaders(includeJson);
    }
    // Fallback to basic headers if chainersRequestHeaders not available
    const headers = {
        "accept": "application/json",
        "accept-language": "vi-VN,vi;q=0.9",
        "referer": "https://chainers.io/game/farm",
    };
    if (includeJson) {
        headers["content-type"] = "application/json";
    }
    return headers;
}

/**
 * Fetch active events from API
 */
async function fetchActiveEvents(context, location = "hub") {
    try {
        const headers = await getHeaders(context, false);
        if (!headers) return null;

        const url = `${MISSIONS_API.ACTIVE_EVENTS}?location=${location}`;
        headers["cache-control"] = "no-cache";
        headers["pragma"] = "no-cache";

        const res = await context.request.get(url, { headers, timeout: 15000 });

        if (res.status() === 304 || res.status() === 204) {
            return null;
        }

        const text = await res.text();
        const data = JSON.parse(text);

        if (data?.success && Array.isArray(data.data)) {
            return data.data;
        }
        return null;
    } catch (e) {
        console.log("❌ Failed to fetch active events:", e.message);
        return null;
    }
}

/**
 * Fetch tasks list for an event
 */
async function fetchTasksList(context, parentCode) {
    try {
        const headers = await getHeaders(context, false);
        if (!headers) return null;

        const url = `${MISSIONS_API.TASKS_LIST}?parentCode=${parentCode}`;
        headers["cache-control"] = "no-cache";

        const res = await context.request.get(url, { headers, timeout: 15000 });

        if (res.status() === 304 || res.status() === 204) {
            return null;
        }

        const text = await res.text();
        const data = JSON.parse(text);

        if (data?.success && data.data?.tasks) {
            return {
                parentCode: data.data.parentCode,
                endDate: data.data.endDate,
                tasks: data.data.tasks.map(parseTaskRequirements),
            };
        }
        return null;
    } catch (e) {
        console.log("❌ Failed to fetch tasks list:", e.message);
        return null;
    }
}

/**
 * Fetch user's task progress
 */
async function fetchTasksProgress(context, parentCode) {
    try {
        const headers = await getHeaders(context, false);
        if (!headers) return null;

        const url = `${MISSIONS_API.TASKS_PROGRESS}?parentCode=${parentCode}`;
        headers["cache-control"] = "no-cache";

        const res = await context.request.get(url, { headers, timeout: 15000 });

        if (res.status() === 304 || res.status() === 204) {
            return null;
        }

        const text = await res.text();
        const data = JSON.parse(text);

        if (data?.success && Array.isArray(data.data)) {
            // Debug: log first item to see all available fields
            if (process.env.CHAINERS_DEBUG_MISSIONS === "1" && data.data[0]) {
                console.log("🔍 Progress API raw fields:", Object.keys(data.data[0]).join(", "));
                console.log("🔍 First progress item:", JSON.stringify(data.data[0]).slice(0, 200));
            }
            return data.data.map(p => ({
                taskId: p.tasksID,
                taskCode: p.tasksCode,
                isAvailable: p.isAvailable,
                statusCode: p.statusCode,
                countRepeats: p.countRepeats,
                isCompleted: p.isCompleted,
            }));
        }
        return null;
    } catch (e) {
        console.log("❌ Failed to fetch tasks progress:", e.message);
        return null;
    }
}

/**
 * Get complete mission status with merged task info and progress
 */
async function getCompleteMissionStatus(context) {
    const events = await fetchActiveEvents(context);
    if (!events) return null;

    const missionStatus = {
        events: [],
        totalTasks: 0,
        completedTasks: 0,
        availableRewards: 0,
    };

    for (const event of events) {
        const [tasksList, tasksProgress] = await Promise.all([
            fetchTasksList(context, event.code),
            fetchTasksProgress(context, event.code),
        ]);

        if (!tasksList || !tasksProgress) continue;

        // Debug: log progress data
        if (process.env.CHAINERS_DEBUG_MISSIONS === "1") {
            console.log("📊 Task Progress Raw:", tasksProgress.map(p => ({ code: p.taskCode, repeats: p.countRepeats, available: p.isAvailable })));
            console.log("📋 Task List Codes:", tasksList.tasks.map(t => t.code));
        }

        // Debug: check first task fields
        if (tasksList.tasks[0]) {
            console.log(`🔍 Task list fields: ${Object.keys(tasksList.tasks[0]).join(", ")}`);
            console.log(`🔍 Sample task: code=${tasksList.tasks[0].code}, _id=${tasksList.tasks[0]._id?.slice(0, 16)}, tasksID=${tasksList.tasks[0].tasksID?.slice(0, 16)}`);
        }

        // Merge task info with progress
        // Note: Progress API uses short codes (e.g., 'reward_pool_any')
        // but task list uses full codes (e.g., 'reward_pool_any_daily_2_6')
        // Match by task.type which is consistent
        const tasks = tasksList.tasks.map(task => {
            const progress = tasksProgress.find(p => p.taskCode === task.type);
            if (progress) {
                // Use tasksID from progress API (this is the claimable task ID)
                task.taskId = progress.taskId;  // This comes from p.tasksID in fetchTasksProgress
                task.currentProgress = progress.countRepeats || 0;
                task.isCompleted = progress.isCompleted;
                task.isAvailable = progress.isAvailable;
                task.statusCode = progress.statusCode;
                task.percentComplete = Math.round(((progress.countRepeats || 0) / task.repeatsNeeded) * 100);
                // Debug: show mapping
                if (task.isCompleted) {
                    console.log(`   📋 Task matched: type=${task.type} → code=${progress.taskCode}, tasksID=${progress.taskId?.slice(0, 16)}..., completed=${progress.isCompleted}`);
                }
            } else {
                // Debug: show unmatched tasks
                if (process.env.CHAINERS_DEBUG_MISSIONS === "1") {
                    console.log(`   ⚠️ No progress match for task type: ${task.type}`);
                }
            }
            return task;
        });

        const completed = tasks.filter(t => t.isCompleted).length;
        const available = tasks.filter(t => t.isAvailable && !t.isCompleted).length;

        missionStatus.events.push({
            code: event.code,
            type: event.eventType, // daily, weekly, monthly
            title: event.title?.en || event.code,
            endDate: event.dateTo,
            isTimeLimited: event.isTimeLimited,
            tasks: tasks,
            completedCount: completed,
            availableCount: available,
            totalCount: tasks.length,
        });

        missionStatus.totalTasks += tasks.length;
        missionStatus.completedTasks += completed;
        missionStatus.availableRewards += available;
    }

    return missionStatus;
}

/**
 * Print mission status summary
 */
function printMissionSummary(missionStatus) {
    if (!missionStatus) {
        console.log("📋 No mission data available");
        return;
    }

    console.log("\n📋 MISSION STATUS");
    console.log("=".repeat(50));

    for (const event of missionStatus.events) {
        const progressBar = "█".repeat(event.completedCount) + "░".repeat(event.totalCount - event.completedCount);
        console.log(`\n${event.title} [${progressBar}] ${event.completedCount}/${event.totalCount}`);
        console.log(`   Ends: ${new Date(event.endDate).toLocaleDateString()}`);

        for (const task of event.tasks) {
            // Show progress: has progress = ⏳, completed = ✅, no progress = 🔒
            const hasProgress = (task.currentProgress || 0) > 0;
            const status = task.isCompleted ? "✅" : hasProgress || task.isAvailable ? "⏳" : "🔒";
            const progress = task.isCompleted
                ? "Done"
                : `${task.currentProgress || 0}/${task.repeatsNeeded}`;
            console.log(`   ${status} ${task.title} (${progress})`);
        }
    }

    console.log("\n" + "=".repeat(50));
    console.log(`Total: ${missionStatus.completedTasks}/${missionStatus.totalTasks} completed`);
    console.log(`Available rewards: ${missionStatus.availableRewards}`);
}

/**
 * Check if specific task type needs action
 */
function getTasksNeedingAction(missionStatus, taskTypeFilter = null) {
    const actions = [];

    for (const event of missionStatus?.events || []) {
        for (const task of event.tasks) {
            if (task.isCompleted) continue;

            // Include if available OR has progress
            const hasProgress = (task.currentProgress || 0) > 0;
            if (!task.isAvailable && !hasProgress) continue;

            // Filter by task type if specified
            if (taskTypeFilter && !task.type.includes(taskTypeFilter)) continue;

            const remaining = task.repeatsNeeded - (task.currentProgress || 0);
            if (remaining > 0) {
                actions.push({
                    eventCode: event.code,
                    eventType: event.type,
                    taskId: task.taskId,
                    taskCode: task.code,
                    taskType: task.type,
                    title: task.title,
                    remaining: remaining,
                    hints: task.automationHints,
                });
            }
        }
    }

    return actions;
}

/**
 * Get next priority task for the bot to complete
 */
function getNextPriorityTask(missionStatus) {
    const actions = getTasksNeedingAction(missionStatus);

    // Priority order for daily tasks
    const priorityOrder = [
        TASK_TYPES.REWARD_POOL_ANY,
        TASK_TYPES.HARVEST_SPECIAL_SEED,
        TASK_TYPES.PHYTOLAMP_USED,
        TASK_TYPES.DAILY_TASK_COMPLETED, // Do this last as it requires others
    ];

    // Sort by priority
    actions.sort((a, b) => {
        const aIndex = priorityOrder.indexOf(a.taskType);
        const bIndex = priorityOrder.indexOf(b.taskType);
        if (aIndex === -1 && bIndex === -1) return 0;
        if (aIndex === -1) return 1;
        if (bIndex === -1) return -1;
        return aIndex - bIndex;
    });

    return actions[0] || null;
}

// ================= MISSION ACTION EXECUTION =================
// These functions perform actions to complete missions
// API endpoints must be captured using CHAINERS_SNIFF_API=1 first

// Mission action API endpoints
const ACTION_APIS = {
    USE_FERTILIZER: "https://chainers.io/api/farm/control/use-fertilizer",
};

/**
 * Execute mission actions based on current priority tasks
 * Returns results of attempted actions
 */
async function executeMissionActions(context, missionStatus, chainersHeaders) {
    const results = {
        attempted: [],
        succeeded: [],
        failed: []
    };

    if (!missionStatus || !chainersHeaders) return results;

    const priorityTask = getNextPriorityTask(missionStatus);
    if (!priorityTask) return results;

    console.log(`🎯 Executing mission action: ${priorityTask.title} (${priorityTask.remaining} remaining)`);

    switch (priorityTask.taskType) {
        case TASK_TYPES.REWARD_POOL_ANY:
            // Reward pool is handled separately in main bot loop
            results.attempted.push({ type: "reward_pool", note: "handled by main loop" });
            break;

        case TASK_TYPES.HARVEST_SPECIAL_SEED:
            // Plant/harvest logic already in main loop
            results.attempted.push({ type: "harvest", note: "handled by main loop" });
            break;

        case TASK_TYPES.WEEKLY_USE_FERTILIZER:
        case "use_fertilizer":
        case "fertilizer_used":
            // Fertilizer is handled directly in main bot loop
            results.attempted.push({ type: "fertilizer", note: "handled by main loop" });
            break;

        default:
            console.log(`⏭️ No automation for task type: ${priorityTask.taskType}`);
            results.attempted.push({ type: priorityTask.taskType, note: "not implemented" });
    }

    return results;
}

/**
 * Use fertilizer on a planted bed
 * API: POST /api/farm/control/use-fertilizer
 * Payload: { userFarmingID, farmFertilizersID }
 */
async function useFertilizer(context, chainersHeaders, userFarmingID, farmFertilizersID) {
    console.log("🧪 Attempting: Use fertilizer");

    if (!userFarmingID || !farmFertilizersID) {
        return { success: false, error: "Missing userFarmingID or farmFertilizersID" };
    }

    try {
        const headers = await chainersHeaders(context, true); // true = include content-type
        if (!headers) {
            return { success: false, error: "No API headers available" };
        }

        const payload = {
            userFarmingID: userFarmingID,
            farmFertilizersID: farmFertilizersID
        };

        console.log(`   Using fertilizer ${farmFertilizersID.slice(0, 12)}... on farm ${userFarmingID.slice(0, 12)}...`);

        const res = await context.request.post(ACTION_APIS.USE_FERTILIZER, {
            headers,
            data: JSON.stringify(payload),
            timeout: 15000
        });

        const status = res.status();
        const text = await res.text();
        const json = JSON.parse(text);

        if (json?.success) {
            console.log(`   ✅ Fertilizer applied! New growth time: ${json.data?.newGrowthTime}s`);
            return {
                success: true,
                data: json.data,
                message: `Fertilizer applied, growth time: ${json.data?.newGrowthTime}s`
            };
        } else {
            console.log(`   ❌ Fertilizer failed: ${json.error || status}`);
            return {
                success: false,
                error: json.error || `HTTP ${status}`,
                errorCode: json.errorCode
            };
        }
    } catch (e) {
        console.log(`   ❌ Fertilizer error: ${e.message}`);
        return { success: false, error: e.message };
    }
}

/**
 * Claim reward for a completed mission task
 * API: POST /api/missions/control/claim-reward
 * Payload: { tasksID: string }
 */
async function claimTaskReward(context, tasksID) {
    if (!tasksID) {
        return { success: false, error: "Missing tasksID" };
    }

    // Debug: log what we're about to send
    if (process.env.CHAINERS_DEBUG_CLAIM === "1") {
        console.log(`   🔍 DEBUG claimTaskReward: tasksID=${tasksID}, length=${tasksID.length}`);
    }

    try {
        const headers = await getHeaders(context, true); // true = include content-type
        if (!headers) {
            return { success: false, error: "No API headers available" };
        }

        const payload = { tasksID: tasksID };

        const res = await context.request.post(MISSIONS_API.CLAIM_REWARD, {
            headers,
            data: JSON.stringify(payload),
            timeout: 15000
        });

        const status = res.status();
        const text = await res.text();
        const json = JSON.parse(text);

        if (json?.success) {
            // Handle both formats: {data: {rewards: []}} and {boosterReceivedCards: []}
            const rewards = json.data?.rewards || json.boosterReceivedCards || [];
            const rewardSummary = rewards.map(r => `${r.rarity || r.code}×${r.count}`).join(", ") || "reward claimed";
            return {
                success: true,
                data: json.data || json,
                rewards: rewards,
                message: `Mission reward claimed: ${rewardSummary}`
            };
        } else {
            // Check if already claimed (Invalid tasksID means reward was taken)
            if (json.error === "Invalid tasksID") {
                console.log(`   ⏭️ Already claimed (tasksID no longer valid)`);
                return {
                    success: true,  // Treat as success - reward was already claimed
                    alreadyClaimed: true,
                    message: "Reward already claimed"
                };
            }
            // Debug: log full error response
            console.log(`   🔍 DEBUG claim: status=${status}, payload=${JSON.stringify(payload)}`);
            console.log(`   🔍 DEBUG claim response: ${JSON.stringify(json).slice(0, 300)}`);
            return {
                success: false,
                error: json.error || `HTTP ${status}`,
                errorCode: json.errorCode,
                status: status
            };
        }
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * Claim all available mission rewards
 * Returns summary of claimed rewards
 */
async function claimAllAvailableRewards(context, missionStatus) {
    const results = {
        claimed: [],
        failed: [],
        total: 0
    };

    if (!missionStatus?.events) {
        console.log("   ⚠️ No mission events to claim from");
        return results;
    }

    let checkedTasks = 0;
    let availableTasks = 0;

    for (const event of missionStatus.events) {
        if (!event.tasks?.length) continue;

        // Refresh progress data for this event to get fresh tasksIDs
        const freshProgress = await fetchTasksProgress(context, event.code);
        if (!freshProgress) {
            console.log(`   ⚠️ Could not refresh progress for ${event.code}`);
            continue;
        }

        // Build a map of fresh progress data by task code
        const freshProgressMap = new Map(freshProgress.map(p => [p.taskCode, p]));

        for (const task of event.tasks) {
            checkedTasks++;
            // Get FRESH progress data for this task
            const freshProgress = freshProgressMap.get(task.type);
            if (!freshProgress) {
                console.log(`   ⚠️ No fresh progress for task: ${task.title} (type=${task.type})`);
                continue;
            }
            // Only claim tasks that are completed AND available (ready for reward)
            if (freshProgress.isCompleted && freshProgress.isAvailable) {
                availableTasks++;
                // Use FRESH tasksID from progress API
                const taskId = freshProgress.taskId;  // This is p.tasksID
                if (!taskId) {
                    console.log(`   ⚠️ Task "${task.title}" missing tasksID`);
                    continue;
                }
                console.log(`🎁 Claiming reward for: ${task.title} (ID: ${taskId?.slice(0, 16)}...)`);
                const claimResult = await claimTaskReward(context, taskId);

                if (claimResult.success) {
                    results.claimed.push({
                        eventCode: event.code,
                        taskTitle: task.title,
                        taskType: task.type,
                        rewards: claimResult.rewards
                    });
                    console.log(`   ✅ ${claimResult.message}`);
                } else {
                    results.failed.push({
                        eventCode: event.code,
                        taskTitle: task.title,
                        error: claimResult.error
                    });
                    console.log(`   ❌ Failed: ${claimResult.error}`);
                }
                results.total++;
            }
        }
    }

    console.log(`   📊 Checked ${checkedTasks} tasks, ${availableTasks} available, claimed ${results.claimed.length}, failed ${results.failed.length}`);
    return results;
}

/**
 * Check if a specific action can be performed
 */
function canPerformAction(actionType, context, inventory) {
    switch (actionType) {
        case "fertilizer":
            // Check if we have fertilizer in inventory
            return inventory.some(item =>
                item.itemType === "fertilizer" || item.itemCode?.includes("fertilizer")
            );
        default:
            return false;
    }
}

// Export all functions and constants
export {
    MISSIONS_API,
    EVENT_CODES,
    TASK_TYPES,
    REWARD_CODES,
    getCurrentEventCodes,
    parseTaskRequirements,
    fetchActiveEvents,
    fetchTasksList,
    fetchTasksProgress,
    getCompleteMissionStatus,
    printMissionSummary,
    getTasksNeedingAction,
    getNextPriorityTask,
    executeMissionActions,
    canPerformAction,
    useFertilizer,
    claimTaskReward,
    claimAllAvailableRewards,
};

// Default export for convenience
export default {
    getCompleteMissionStatus,
    printMissionSummary,
    getNextPriorityTask,
    getTasksNeedingAction,
    executeMissionActions,
    canPerformAction,
    useFertilizer,
    claimTaskReward,
    claimAllAvailableRewards,
};
