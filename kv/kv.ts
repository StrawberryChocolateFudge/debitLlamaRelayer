/// <reference lib="deno.unstable" />

import { solveDynamicPayments } from "../solvers/solveDynamicPayments.ts";
import { solveFixedPayments } from "../solvers/solveFixedPayments.ts";
import {
  DynamicPaymentRequestJobRow,
  isPaymentIntentRow,
  PaymentIntentRow,
} from "../web3/constants..ts";

// Create a the kv store

export const kv = await Deno.openKv();

// Listen to the enqueued jobs
kv.listenQueue(async (msg: any) => {
  const paymentIntentRow = msg.value as
    | PaymentIntentRow
    | DynamicPaymentRequestJobRow;
  switch (msg.type as KvMessageType) {
    case KvMessageType.created_fixed:
      await solveFixedPayments(paymentIntentRow as PaymentIntentRow)
        .finally(() => {
          deleteLock(paymentIntentRow as PaymentIntentRow, msg.type);
        });
      break;
    case KvMessageType.recurring_fixed:
      await solveFixedPayments(paymentIntentRow as PaymentIntentRow)
        .finally(() => {
          deleteLock(paymentIntentRow as PaymentIntentRow, msg.type);
        });
      break;
    case KvMessageType.dynamic_payment:
      await solveDynamicPayments(
        paymentIntentRow as DynamicPaymentRequestJobRow,
      ).finally(() => {
        deleteLock(paymentIntentRow as DynamicPaymentRequestJobRow, msg.type);
      });
      break;
    default:
      console.error("Unknown message received:", msg);
      break;
  }
});

// The type of payment intents relayed
export enum KvMessageType {
  created_fixed = "created_fixed",
  recurring_fixed = "recurring_fixed",
  dynamic_payment = "dynamic_payment",
}
// The relayed payment intents have locks to avoid doing one twice
export enum LockType {
  locked_created_fixed = "locked_created_fixed",
  locked_recurring_fixed = "locked_recurring_fixed",
  locked_dynamic = "locked_dynamic",
}
//You can get the kv keys using this function
export const keys = {
  queue_size: () => ["queue", "size"],
  fixed_created: (pi?: string) =>
    pi
      ? ["paymentIntents", "FIXED", "CREATED", pi]
      : ["paymentIntents", "FIXED", "CREATED"],
  fixed_created_lock: (
    pi: string,
  ) => ["paymentIntents", "FIXED", "CREATED", pi, "LOCK"],
  fixed_recurring: (
    pi?: string,
  ) =>
    pi
      ? ["paymentIntents", "FIXED", "RECURRING", pi]
      : ["paymentIntents", "FIXED", "RECURRING"],
  fixed_recurring_lock: (
    pi: string,
  ) => ["paymentIntents", "FIXED", "RECURRING", pi, "LOCK"],
  dynamic_payment: (
    pi?: string,
  ) => pi ? ["paymentIntents", "DYNAMIC", pi] : ["paymentIntents", "DYNAMIC"],
  dynamic_payment_lock: (
    pi: string,
  ) => ["paymentIntents", "DYNAMIC", pi, "LOCK"],
};
// This is a switch to help finding a key fast
function mapKeysToKvMessageType(
  type: KvMessageType | LockType,
): CallableFunction | undefined {
  switch (type) {
    case KvMessageType.created_fixed:
      return keys.fixed_created;
    case KvMessageType.recurring_fixed:
      return keys.fixed_recurring;
    case KvMessageType.dynamic_payment:
      return keys.dynamic_payment;
    case LockType.locked_dynamic:
      return keys.dynamic_payment_lock;
    case LockType.locked_created_fixed:
      return keys.fixed_created_lock;
    case LockType.locked_recurring_fixed:
      return keys.fixed_recurring_lock;

    default:
      break;
  }
}

// This function maps a kvMessageType to a lock
function mapKvMessageToLocks(type: KvMessageType): LockType {
  switch (type) {
    case KvMessageType.created_fixed:
      return LockType.locked_created_fixed;
    case KvMessageType.recurring_fixed:
      return LockType.locked_recurring_fixed;
    case KvMessageType.dynamic_payment:
      return LockType.locked_dynamic;
    default:
      return type;
  }
}

// Set created Fixed payment intents in the database

export async function setCreatedFixed(
  paymentIntents: PaymentIntentRow[],
) {
  for (let i = 0; i < paymentIntents.length; i++) {
    await lockPiForProcessing(
      KvMessageType.created_fixed,
      paymentIntents[i],
    );
  }
}

// Set a new recurring payment intent to database and enqueue processing

export async function setRecurringFixed(paymentIntents: PaymentIntentRow[]) {
  for (let i = 0; i < paymentIntents.length; i++) {
    await lockPiForProcessing(
      KvMessageType.recurring_fixed,
      paymentIntents[i],
    );
  }
}

export async function setDynamicPayment(paymentIntents: PaymentIntentRow[]) {
  for (let i = 0; i < paymentIntents.length; i++) {
    await lockPiForProcessing(
      KvMessageType.dynamic_payment,
      paymentIntents[i],
    );
  }
}

function lockKeyFromKvMessageType(type: KvMessageType, paymentIntent: string) {
  const kvMessageLock = mapKvMessageToLocks(type);

  const buildKey = mapKeysToKvMessageType(
    kvMessageLock,
  ) as CallableFunction;

  return buildKey(paymentIntent);
}

// Lock a payment intent for processing to ensure it is not processed twice by accident!

export async function lockPiForProcessing(
  type: KvMessageType,
  paymentIntentRow: PaymentIntentRow,
) {
  const lockkey = lockKeyFromKvMessageType(
    type,
    paymentIntentRow.paymentIntent,
  );

  const pi_lock = await kv.get(lockkey);

  const queue_size = await kv.get(keys.queue_size());

  if (queue_size.value === 100000) {
    // If the queue is full, I don't enqueue this paymentIntent. Next time!
    return;
  }

  if (pi_lock.value === null) {
    // There is no lock,] yet so I can create a default one and enqueue the job
    await kv.atomic()
      .check(pi_lock)
      .check(queue_size)
      .set(lockkey, true)
      .set(
        keys.queue_size(),
        getNewQueueSize(queue_size.value as number | null, "INC"),
      )
      .enqueue({
        type,
        value: paymentIntentRow,
      })
      .commit();
  }
  //If there is a lock already the paymentIntent is already queued.
}

// delete created fixed payment intents from the db
export async function deleteLock(
  pi: PaymentIntentRow | DynamicPaymentRequestJobRow,
  type: KvMessageType,
) {
  const queue_size = await kv.get(keys.queue_size());

  let pi_row;
  if (isPaymentIntentRow(pi)) {
    pi_row = pi.paymentIntent;
  } else {
    pi_row = pi.paymentIntent_id.paymentIntent;
  }

  const lockkey = lockKeyFromKvMessageType(type, pi_row);

  await kv.atomic()
    .delete(lockkey)
    .set(
      keys.queue_size(),
      getNewQueueSize(queue_size.value as number | null, "INC"),
    )
    .commit();
}

function getNewQueueSize(
  queue_size: null | number,
  order: "INC" | "DEC",
) {
  if (!queue_size) {
    return 1;
  }
  if (order === "INC") {
    return queue_size + 1;
  }

  //If order is DESC

  if (queue_size === 0) {
    return queue_size;
  }

  return queue_size - 1;
}