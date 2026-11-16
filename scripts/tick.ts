import { getStore } from "../db/store";
import { runSchedulerTick } from "../apps/web/lib/server/automations";
import { scheduledRunStarter } from "../apps/web/lib/server/scheduled-run-starter";

const rawLimit = process.env.TICK_LIMIT;
const limit = rawLimit ? Number(rawLimit) : undefined;

const result = await runSchedulerTick({
  store: getStore(),
  startScheduledRun: scheduledRunStarter,
  limit,
});

console.log(JSON.stringify(result));
