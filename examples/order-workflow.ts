/**
 * Durable order workflow with crash recovery.
 *
 * Run it once and it "crashes" after charging the card. Run it again with the
 * same data file and it resumes: the charge step is replayed from disk (NOT
 * repeated) and the workflow finishes by shipping. This is the whole point of
 * durable execution: a process can die at any step and pick up exactly where it
 * left off, without double-charging.
 *
 *   npx tsx examples/order-workflow.ts        # first run: charges, then crashes
 *   npx tsx examples/order-workflow.ts        # second run: resumes and ships
 *   rm keel-data/orders.json                  # reset the demo
 */
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { Keel, FileStore, defineWorkflow } from '../src/index.js';

const DATA_DIR = 'keel-data';
const DB_FILE = join(DATA_DIR, 'orders.json');
const RUN_FILE = join(DATA_DIR, 'last-run.txt');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

interface OrderInput {
  orderId: string;
  amountUsd: number;
}

// Flip to false on the second run to let the workflow complete.
const SHOULD_CRASH = !existsSync(RUN_FILE);

const orderWorkflow = defineWorkflow<OrderInput, { shipped: boolean }>(
  'order',
  async (ctx, input) => {
    const charge = await ctx.step('charge-card', () => {
      console.log(`  charging $${input.amountUsd} for ${input.orderId}`);
      return { chargeId: `ch_${input.orderId}`, amount: input.amountUsd };
    });

    if (SHOULD_CRASH) {
      console.log('  process crashes here (simulated)');
      throw new Error('process died after charging');
    }

    await ctx.step('reserve-inventory', () => {
      console.log('  reserving inventory');
      return { reserved: true };
    });

    const shipment = await ctx.step('ship', () => {
      console.log(`  shipping order ${input.orderId} (charge ${charge.chargeId})`);
      return { shipped: true };
    });

    return shipment;
  },
);

const store = new FileStore(DB_FILE);
const keel = new Keel({ store });

async function main(): Promise<void> {
  if (SHOULD_CRASH) {
    console.log('First run: charge then crash.');
    const result = await keel.run(orderWorkflow, {
      orderId: 'A-1001',
      amountUsd: 49,
    });
    writeFileSync(RUN_FILE, result.runId, 'utf8');
    console.log(`Run ${result.runId} ended as: ${result.status}`);
    console.log('Now run this script again to resume and ship.');
  } else {
    const runId = readFileSync(RUN_FILE, 'utf8').trim();
    console.log(`Second run: resuming ${runId}.`);
    keel.register(orderWorkflow);
    const result = await keel.resume(runId);
    console.log(`Run ${runId} ended as: ${result.status}`);
    console.log('Notice the card was NOT charged a second time above.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
