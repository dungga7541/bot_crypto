# Mission System Integration Guide

## Import the missions module in bot_chainners.js

Add this import at the top of bot_chainners.js:

```javascript
import { 
    getCompleteMissionStatus, 
    printMissionSummary, 
    getNextPriorityTask,
    getTasksNeedingAction,
    TASK_TYPES 
} from './missions.js';
```

## Usage Examples

### 1. Check missions on bot startup

```javascript
// After login success, check missions
async function checkDailyMissions(context) {
    console.log("📋 Checking daily missions...");
    
    const missionStatus = await getCompleteMissionStatus(context);
    if (missionStatus) {
        printMissionSummary(missionStatus);
        
        // Check if any reward pool tasks need completion
        const poolTasks = getTasksNeedingAction(missionStatus, "reward_pool");
        if (poolTasks.length > 0) {
            console.log(`📦 Need to use reward pool ${poolTasks[0].remaining} more times`);
        }
        
        // Check phytolamp tasks
        const lampTasks = getTasksNeedingAction(missionStatus, "phytolamp");
        if (lampTasks.length > 0) {
            console.log(`💡 Need to use phytolamp ${lampTasks[0].remaining} more times`);
        }
    }
    return missionStatus;
}
```

### 2. Integrate with main loop

```javascript
// Add to main bot loop - check missions every few cycles
let missionStatus = null;
let lastMissionCheck = 0;
const MISSION_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

async function mainLoop(context) {
    // ... existing code ...
    
    // Check missions periodically
    if (Date.now() - lastMissionCheck > MISSION_CHECK_INTERVAL) {
        missionStatus = await checkDailyMissions(context);
        lastMissionCheck = Date.now();
    }
    
    // Use mission status to influence bot behavior
    if (missionStatus) {
        const nextTask = getNextPriorityTask(missionStatus);
        
        if (nextTask) {
            console.log(`🎯 Next priority: ${nextTask.title}`);
            
            // Adjust behavior based on task type
            switch (nextTask.taskType) {
                case TASK_TYPES.REWARD_POOL_ANY:
                    // Prioritize reward pool deposits
                    await depositStoredVegetablesToRewardPool(context);
                    break;
                    
                case TASK_TYPES.HARVEST_SPECIAL_SEED:
                    // Look for special seeds to harvest
                    await fetchFarmGardens(context, { minIntervalMs: 0 });
                    if (canHarvest) {
                        await collectHarvestViaApi(context);
                    }
                    break;
                    
                case TASK_TYPES.PHYTOLAMP_USED:
                    // Note: Phytolamp usage needs UI interaction
                    console.log("💡 Phytolamp task pending - needs manual/UI action");
                    break;
            }
        }
    }
    
    // ... rest of loop ...
}
```

### 3. Mission-aware reward pool deposits

```javascript
async function missionAwareRewardPoolDeposit(context, missionStatus) {
    const poolTasks = getTasksNeedingAction(missionStatus, "reward_pool");
    
    if (poolTasks.length === 0) {
        // No mission requirement - deposit normally with limit
        await depositStoredVegetablesToRewardPool(context);
        return;
    }
    
    // Need to deposit more for mission - increase limit
    const needed = poolTasks[0].remaining;
    console.log(`📦 Mission requires ${needed} more reward pool deposits`);
    
    // Override the max per request temporarily
    const originalMax = process.env.CHAINERS_REWARD_POOL_MAX_ITEMS_PER_REQUEST;
    process.env.CHAINERS_REWARD_POOL_MAX_ITEMS_PER_REQUEST = "100";
    
    await depositStoredVegetablesToRewardPool(context);
    
    // Restore original setting
    if (originalMax) {
        process.env.CHAINERS_REWARD_POOL_MAX_ITEMS_PER_REQUEST = originalMax;
    }
}
```

## API Endpoints Found in HAR

### Active Events (Daily/Weekly/Monthly)
- **URL**: `GET /api/missions/data/active-events?location=hub`
- **Response**: List of active mission events with codes like `april2026_daily`

### Task List
- **URL**: `GET /api/missions/data/events-tasks-list?parentCode={eventCode}`
- **Response**: Tasks with requirements (e.g., "Collect rewards 6 times")

### Task Progress
- **URL**: `GET /api/missions/user/tasks-progress?parentCode={eventCode}`
- **Response**: User's current progress on each task

### Task Rewards
- **URL**: `GET /api/missions/data/events-tasks-rewards?codes={rewardCodes}`
- **Response**: Reward details for completing tasks

## Task Types Detected

| Task Type | Description | Auto-doable? |
|-----------|-------------|--------------|
| `reward_pool_any` | Collect rewards from pool X times | ✅ Yes |
| `harvest_special_seed` | Harvest special seeds X times | ✅ Yes |
| `phytolamp_used` | Use phytolamp on planted seeds | ❌ UI only |
| `daily_task_completed` | Complete daily missions | ✅ Auto-completes |
| `weekly_login` | Login X days | ✅ Yes |
| `weekly_harvest_total` | Harvest total vegetables | ✅ Yes |

## Monthly Event Codes

Event codes follow pattern: `{month}{year}_{type}`
- April 2026: `april2026_daily`, `april2026_weekly`, `april2026_monthly`
- May 2026: `may2026_daily`, `may2026_weekly`, `may2026_monthly`

The module auto-detects current month codes with `getCurrentEventCodes()`.
