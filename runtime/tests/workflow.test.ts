import { test, expect, beforeEach, describe } from "bun:test";
import { Database } from "bun:sqlite";
import {
  WorkflowEntrypointBase,
  SqliteWorkflowBinding,
  SqliteWorkflowInstance,
  NonRetryableError,
} from "../bindings/workflow";
import type { WorkflowStepConfig } from "../bindings/workflow";
import { runMigrations } from "../db";

class TestWorkflow extends WorkflowEntrypointBase {
  override async run(event: { payload: { value: string } }, step: { do: <T>(name: string, cb: () => Promise<T>) => Promise<T>; sleep: (name: string, duration: string) => Promise<void> }): Promise<unknown> {
    const result = await step.do("process", async () => {
      return { input: event.payload.value, processed: true };
    });
    await step.sleep("pause", "1 second");
    return result;
  }
}

class FailingWorkflow extends WorkflowEntrypointBase {
  override async run(): Promise<unknown> {
    throw new Error("workflow failed");
  }
}

class SlowWorkflow extends WorkflowEntrypointBase {
  override async run(_event: unknown, step: { do: <T>(name: string, cb: () => Promise<T>) => Promise<T>; sleep: (name: string, duration: string) => Promise<void> }): Promise<unknown> {
    await step.do("step1", async () => "a");
    await step.sleep("wait", "1 second");
    await step.do("step2", async () => "b");
    await step.sleep("wait2", "1 second");
    return "done";
  }
}

class EventWorkflow extends WorkflowEntrypointBase {
  override async run(_event: unknown, step: { do: <T>(name: string, cb: () => Promise<T>) => Promise<T>; waitForEvent: <T>(name: string, options: { type: string; timeout?: string }) => Promise<{ payload: T; timestamp: Date; type: string }> }): Promise<unknown> {
    const event = await step.waitForEvent<{ approved: boolean }>("wait-approval", { type: "approval" });
    const result = await step.do("process", async () => {
      return { approved: event.payload.approved };
    });
    return result;
  }
}

class SleepUntilWorkflow extends WorkflowEntrypointBase {
  override async run(_event: unknown, step: { do: <T>(name: string, cb: () => Promise<T>) => Promise<T>; sleepUntil: (name: string, timestamp: Date) => Promise<void> }): Promise<unknown> {
    await step.sleepUntil("wait-until", new Date(Date.now() + 10));
    return "woke up";
  }
}

class TimeoutEventWorkflow extends WorkflowEntrypointBase {
  override async run(_event: unknown, step: { waitForEvent: <T>(name: string, options: { type: string; timeout?: string }) => Promise<{ payload: T; timestamp: Date; type: string }> }): Promise<unknown> {
    await step.waitForEvent("wait-timeout", { type: "never", timeout: "50 milliseconds" });
    return "should not reach";
  }
}

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

describe("WorkflowEntrypointBase", () => {
  test("run throws by default", async () => {
    const wf = new WorkflowEntrypointBase({}, {});
    await expect(wf.run({}, {})).rejects.toThrow("run() must be implemented");
  });

  test("has env and ctx", () => {
    const env = { KV: "test" };
    const wf = new WorkflowEntrypointBase({}, env);
    expect(wf.env).toBe(env);
    expect(wf.ctx.env).toBe(env);
  });
});

describe("SqliteWorkflowBinding", () => {
  let binding: SqliteWorkflowBinding;

  beforeEach(() => {
    binding = new SqliteWorkflowBinding(db, "test-workflow", "TestWorkflow");
    binding._setClass(TestWorkflow, { TEST: true });
  });

  test("create returns instance with id", async () => {
    const instance = await binding.create({ params: { value: "hello" } });
    expect(instance.id).toBeTypeOf("string");
    expect(instance.id.length).toBeGreaterThan(0);
  });

  test("create generates unique ids", async () => {
    const a = await binding.create();
    const b = await binding.create();
    expect(a.id).not.toBe(b.id);
  });

  test("create with custom id", async () => {
    const instance = await binding.create({ id: "my-custom-id", params: { value: "test" } });
    expect(instance.id).toBe("my-custom-id");
  });

  test("create throws if class not wired", async () => {
    const binding2 = new SqliteWorkflowBinding(db, "test", "Test");
    await expect(binding2.create()).rejects.toThrow("not wired");
  });

  test("workflow persists to database", async () => {
    const instance = await binding.create({ params: { value: "hello" } });
    const row = db.query("SELECT * FROM workflow_instances WHERE id = ?").get(instance.id) as {
      id: string;
      workflow_name: string;
      class_name: string;
      params: string;
      status: string;
    };
    expect(row).not.toBeNull();
    expect(row.workflow_name).toBe("test-workflow");
    expect(row.class_name).toBe("TestWorkflow");
    expect(JSON.parse(row.params)).toEqual({ value: "hello" });
    expect(row.status).toBe("running");
  });

  test("workflow completes and updates status", async () => {
    const instance = await binding.create({ params: { value: "test" } });
    await new Promise((r) => setTimeout(r, 100));

    const s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.output).toEqual({ input: "test", processed: true });
  });

  test("failing workflow sets errored status", async () => {
    const failBinding = new SqliteWorkflowBinding(db, "fail-wf", "FailingWorkflow");
    failBinding._setClass(FailingWorkflow, {});
    const instance = await failBinding.create();
    await new Promise((r) => setTimeout(r, 100));

    const s = await instance.status();
    expect(s.status).toBe("errored");
    expect(s.error).toEqual({ name: "Error", message: "workflow failed" });
  });

  test("get returns instance handle", async () => {
    const created = await binding.create({ params: { value: "test" } });
    const retrieved = await binding.get(created.id);
    expect(retrieved.id).toBe(created.id);
  });

  test("get throws for non-existent id", async () => {
    await expect(binding.get("non-existent")).rejects.toThrow("not found");
  });

  test("terminate aborts workflow", async () => {
    const instance = await binding.create({ params: { value: "test" } });
    await instance.terminate();

    const s = await instance.status();
    expect(s.status).toBe("terminated");
  });

  test("pause and resume", async () => {
    const instance = await binding.create({ params: { value: "test" } });

    await instance.pause();
    let s = await instance.status();
    expect(s.status).toBe("paused");

    await instance.resume();
    s = await instance.status();
    expect(s.status).toBe("running");
  });

  test("status on non-existent instance throws", async () => {
    const ghost = new SqliteWorkflowInstance(db, "ghost-id", null);
    await expect(ghost.status()).rejects.toThrow("not found");
  });

  test("persistence across binding instances", async () => {
    const instance = await binding.create({ params: { value: "persist" } });
    await new Promise((r) => setTimeout(r, 100));

    const binding2 = new SqliteWorkflowBinding(db, "test-workflow", "TestWorkflow");
    binding2._setClass(TestWorkflow, { TEST: true });
    const retrieved = await binding2.get(instance.id);
    const s = await retrieved.status();
    expect(s.status).toBe("complete");
    expect(s.output).toEqual({ input: "persist", processed: true });
  });
});

describe("createBatch", () => {
  let binding: SqliteWorkflowBinding;

  beforeEach(() => {
    binding = new SqliteWorkflowBinding(db, "test-workflow", "TestWorkflow");
    binding._setClass(TestWorkflow, { TEST: true });
  });

  test("creates multiple instances", async () => {
    const instances = await binding.createBatch([
      { params: { value: "a" } },
      { params: { value: "b" } },
      { params: { value: "c" } },
    ]);
    expect(instances).toHaveLength(3);
    const ids = instances.map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
  });

  test("creates instances with custom ids", async () => {
    const instances = await binding.createBatch([
      { id: "batch-1", params: { value: "a" } },
      { id: "batch-2", params: { value: "b" } },
    ]);
    expect(instances[0]!.id).toBe("batch-1");
    expect(instances[1]!.id).toBe("batch-2");
  });

  test("all batch instances complete", async () => {
    const instances = await binding.createBatch([
      { params: { value: "x" } },
      { params: { value: "y" } },
    ]);
    await new Promise((r) => setTimeout(r, 200));

    for (const inst of instances) {
      const s = await inst.status();
      expect(s.status).toBe("complete");
    }
  });

  test("empty batch returns empty array", async () => {
    const instances = await binding.createBatch([]);
    expect(instances).toHaveLength(0);
  });
});

describe("sleepUntil", () => {
  test("sleepUntil waits until timestamp", async () => {
    const binding = new SqliteWorkflowBinding(db, "sleep-wf", "SleepUntilWorkflow");
    binding._setClass(SleepUntilWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 200));

    const s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.output).toBe("woke up");
  });

  test("sleepUntil with past timestamp resolves immediately", async () => {
    class PastSleepWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { sleepUntil: (name: string, timestamp: Date) => Promise<void> }): Promise<unknown> {
        await step.sleepUntil("past", new Date(Date.now() - 1000));
        return "immediate";
      }
    }
    const binding = new SqliteWorkflowBinding(db, "past-sleep", "PastSleepWorkflow");
    binding._setClass(PastSleepWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 100));

    const s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.output).toBe("immediate");
  });
});

describe("waitForEvent / sendEvent", () => {
  test("sendEvent resolves waiting workflow", async () => {
    const binding = new SqliteWorkflowBinding(db, "event-wf", "EventWorkflow");
    binding._setClass(EventWorkflow, {});
    const instance = await binding.create();

    await new Promise((r) => setTimeout(r, 50));

    let s = await instance.status();
    expect(s.status).toBe("waiting");

    await instance.sendEvent({ type: "approval", payload: { approved: true } });

    await new Promise((r) => setTimeout(r, 100));

    s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.output).toEqual({ approved: true });
  });

  test("waitForEvent times out", async () => {
    const binding = new SqliteWorkflowBinding(db, "timeout-wf", "TimeoutEventWorkflow");
    binding._setClass(TimeoutEventWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 200));

    const s = await instance.status();
    expect(s.status).toBe("errored");
    expect(s.error!.message).toContain("timed out");
  });

  test("sendEvent before waitForEvent stores event in DB", async () => {
    class LateEventWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { do: <T>(name: string, cb: () => Promise<T>) => Promise<T>; sleep: (name: string, duration: string) => Promise<void>; waitForEvent: <T>(name: string, options: { type: string }) => Promise<{ payload: T; timestamp: Date; type: string }> }): Promise<unknown> {
        await step.sleep("delay", "1 second");
        const event = await step.waitForEvent<{ msg: string }>("get-data", { type: "data" });
        return event.payload;
      }
    }
    const binding = new SqliteWorkflowBinding(db, "late-event", "LateEventWorkflow");
    binding._setClass(LateEventWorkflow, {});
    const instance = await binding.create();

    await instance.sendEvent({ type: "data", payload: { msg: "early" } });

    const row = db.query("SELECT * FROM workflow_events WHERE instance_id = ?").get(instance.id);
    expect(row).not.toBeNull();

    await new Promise((r) => setTimeout(r, 200));

    const s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.output).toEqual({ msg: "early" });
  });

  test("sendEvent via get() handle", async () => {
    const binding = new SqliteWorkflowBinding(db, "event-wf2", "EventWorkflow");
    binding._setClass(EventWorkflow, {});
    const instance = await binding.create();

    await new Promise((r) => setTimeout(r, 50));

    const retrieved = await binding.get(instance.id);
    await retrieved.sendEvent({ type: "approval", payload: { approved: false } });

    await new Promise((r) => setTimeout(r, 100));

    const s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.output).toEqual({ approved: false });
  });

  test("terminate cancels waitForEvent", async () => {
    const binding = new SqliteWorkflowBinding(db, "term-event", "EventWorkflow");
    binding._setClass(EventWorkflow, {});
    const instance = await binding.create();

    await new Promise((r) => setTimeout(r, 50));
    let s = await instance.status();
    expect(s.status).toBe("waiting");

    await instance.terminate();
    s = await instance.status();
    expect(s.status).toBe("terminated");
  });

  test("waitForEvent returns WorkflowStepEvent with payload, timestamp, type", async () => {
    class EventStructWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { waitForEvent: <T>(name: string, options: { type: string }) => Promise<{ payload: T; timestamp: Date; type: string }> }): Promise<unknown> {
        const event = await step.waitForEvent<{ data: number }>("get-event", { type: "mytype" });
        return { payload: event.payload, type: event.type, hasTimestamp: event.timestamp instanceof Date };
      }
    }
    const binding = new SqliteWorkflowBinding(db, "event-struct", "EventStructWorkflow");
    binding._setClass(EventStructWorkflow, {});
    const instance = await binding.create();

    await new Promise((r) => setTimeout(r, 50));
    await instance.sendEvent({ type: "mytype", payload: { data: 42 } });
    await new Promise((r) => setTimeout(r, 100));

    const s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.output).toEqual({ payload: { data: 42 }, type: "mytype", hasTimestamp: true });
  });
});

describe("pause-aware step execution", () => {
  test("pause blocks step execution until resume", async () => {
    const binding = new SqliteWorkflowBinding(db, "slow-wf", "SlowWorkflow");
    binding._setClass(SlowWorkflow, {});
    const instance = await binding.create();

    await instance.pause();
    let s = await instance.status();
    expect(s.status).toBe("paused");

    await new Promise((r) => setTimeout(r, 100));
    s = await instance.status();
    expect(s.status).toBe("paused");

    await instance.resume();
    await new Promise((r) => setTimeout(r, 200));
    s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.output).toBe("done");
  });
});

describe("step retry config", () => {
  test("step.do retries on failure with constant backoff", async () => {
    let attempts = 0;
    class RetryWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { do: <T>(name: string, config: WorkflowStepConfig, cb: () => Promise<T>) => Promise<T> }): Promise<unknown> {
        const result = await step.do("flaky", { retries: { limit: 3, delay: "10 milliseconds", backoff: "constant" } }, async () => {
          attempts++;
          if (attempts < 3) throw new Error("transient failure");
          return "success";
        });
        return result;
      }
    }
    const binding = new SqliteWorkflowBinding(db, "retry-wf", "RetryWorkflow");
    binding._setClass(RetryWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 300));

    const s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.output).toBe("success");
    expect(attempts).toBe(3);
  });

  test("step.do fails after exhausting retries", async () => {
    class AlwaysFailWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { do: <T>(name: string, config: WorkflowStepConfig, cb: () => Promise<T>) => Promise<T> }): Promise<unknown> {
        return await step.do("broken", { retries: { limit: 2, delay: "10 milliseconds" } }, async () => {
          throw new Error("permanent failure");
        });
      }
    }
    const binding = new SqliteWorkflowBinding(db, "exhaust-wf", "AlwaysFailWorkflow");
    binding._setClass(AlwaysFailWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 300));

    const s = await instance.status();
    expect(s.status).toBe("errored");
    expect(s.error!.message).toContain("permanent failure");
  });

  test("NonRetryableError skips retries", async () => {
    let attempts = 0;
    class NonRetryWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { do: <T>(name: string, config: WorkflowStepConfig, cb: () => Promise<T>) => Promise<T> }): Promise<unknown> {
        return await step.do("no-retry", { retries: { limit: 5, delay: "10 milliseconds" } }, async () => {
          attempts++;
          throw new NonRetryableError("don't retry this");
        });
      }
    }
    const binding = new SqliteWorkflowBinding(db, "nonretry-wf", "NonRetryWorkflow");
    binding._setClass(NonRetryWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 100));

    const s = await instance.status();
    expect(s.status).toBe("errored");
    expect(s.error!.message).toContain("don't retry this");
    expect(attempts).toBe(1);
  });

  test("step.do with timeout", async () => {
    class TimeoutStepWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { do: <T>(name: string, config: WorkflowStepConfig, cb: () => Promise<T>) => Promise<T> }): Promise<unknown> {
        return await step.do("slow-step", { timeout: "50 milliseconds" }, async () => {
          await new Promise((r) => setTimeout(r, 5000));
          return "should not reach";
        });
      }
    }
    const binding = new SqliteWorkflowBinding(db, "timeout-step", "TimeoutStepWorkflow");
    binding._setClass(TimeoutStepWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 200));

    const s = await instance.status();
    expect(s.status).toBe("errored");
    expect(s.error!.message).toContain("timed out");
  });

  test("exponential backoff increases delay", async () => {
    const timestamps: number[] = [];
    let attempts = 0;
    class ExpBackoffWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { do: <T>(name: string, config: WorkflowStepConfig, cb: () => Promise<T>) => Promise<T> }): Promise<unknown> {
        return await step.do("exp", { retries: { limit: 3, delay: "20 milliseconds", backoff: "exponential" } }, async () => {
          timestamps.push(Date.now());
          attempts++;
          if (attempts < 4) throw new Error("fail");
          return "ok";
        });
      }
    }
    const binding = new SqliteWorkflowBinding(db, "exp-wf", "ExpBackoffWorkflow");
    binding._setClass(ExpBackoffWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 500));

    const s = await instance.status();
    expect(s.status).toBe("complete");
    // Verify increasing delays: delay 0 = 20ms, delay 1 = 40ms, delay 2 = 80ms
    if (timestamps.length >= 3) {
      const d1 = timestamps[1]! - timestamps[0]!;
      const d2 = timestamps[2]! - timestamps[1]!;
      expect(d2).toBeGreaterThan(d1);
    }
  });
});

describe("step checkpointing", () => {
  test("step results are cached in workflow_steps table", async () => {
    const binding = new SqliteWorkflowBinding(db, "cache-wf", "TestWorkflow");
    binding._setClass(TestWorkflow, { TEST: true });
    const instance = await binding.create({ params: { value: "cached" } });
    await new Promise((r) => setTimeout(r, 100));

    const rows = db.query("SELECT * FROM workflow_steps WHERE instance_id = ?").all(instance.id) as { step_name: string; output: string }[];
    expect(rows.length).toBeGreaterThan(0);
    const processStep = rows.find((r) => r.step_name === "process");
    expect(processStep).not.toBeUndefined();
    expect(JSON.parse(processStep!.output)).toEqual({ input: "cached", processed: true });
  });

  test("restart clears cached steps", async () => {
    class RestartableWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { do: <T>(name: string, cb: () => Promise<T>) => Promise<T> }): Promise<unknown> {
        return await step.do("compute", async () => Date.now());
      }
    }
    const binding = new SqliteWorkflowBinding(db, "restart-cache", "RestartableWorkflow");
    binding._setClass(RestartableWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 100));

    const s1 = await instance.status();
    expect(s1.status).toBe("complete");
    const firstOutput = s1.output;

    // Restart clears cached steps, so step should re-execute
    await instance.restart(RestartableWorkflow, {}, db);
    await new Promise((r) => setTimeout(r, 100));

    const s2 = await instance.status();
    expect(s2.status).toBe("complete");
    // The output should be different because step was re-executed (new timestamp)
    expect(s2.output).not.toBe(firstOutput);

    // Verify steps were cleared
    const stepsAfterRestart = db.query("SELECT * FROM workflow_steps WHERE instance_id = ?").all(instance.id);
    expect(stepsAfterRestart.length).toBe(1); // Only the new step
  });
});

describe("status structure", () => {
  test("error status returns structured error object", async () => {
    const binding = new SqliteWorkflowBinding(db, "err-struct", "FailingWorkflow");
    binding._setClass(FailingWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 100));

    const s = await instance.status();
    expect(s.status).toBe("errored");
    expect(s.error).toEqual({ name: "Error", message: "workflow failed" });
  });

  test("complete status has no error field", async () => {
    const binding = new SqliteWorkflowBinding(db, "ok-struct", "TestWorkflow");
    binding._setClass(TestWorkflow, { TEST: true });
    const instance = await binding.create({ params: { value: "test" } });
    await new Promise((r) => setTimeout(r, 100));

    const s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.error).toBeUndefined();
    expect(s.output).toBeDefined();
  });
});

describe("queued status and concurrency limits", () => {
  test("instances are queued when concurrency limit is reached", async () => {
    class SlowishWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { sleep: (name: string, duration: string) => Promise<void> }): Promise<unknown> {
        await step.sleep("wait", "1 second");
        return "done";
      }
    }
    const binding = new SqliteWorkflowBinding(db, "conc-wf", "SlowishWorkflow", { maxConcurrentInstances: 1 });
    binding._setClass(SlowishWorkflow, {});

    const first = await binding.create({ id: "first" });
    const second = await binding.create({ id: "second" });

    // First should be running, second should be queued
    let s1 = await first.status();
    let s2 = await second.status();
    expect(s1.status).toBe("running");
    expect(s2.status).toBe("queued");

    // Wait for first to complete
    await new Promise((r) => setTimeout(r, 100));
    s1 = await first.status();
    expect(s1.status).toBe("complete");

    // Second should now be running or complete
    await new Promise((r) => setTimeout(r, 100));
    s2 = await second.status();
    expect(["running", "complete"]).toContain(s2.status);

    // Wait for second to finish
    await new Promise((r) => setTimeout(r, 200));
    s2 = await second.status();
    expect(s2.status).toBe("complete");
  });

  test("terminate queued instance", async () => {
    class SlowishWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { sleep: (name: string, duration: string) => Promise<void> }): Promise<unknown> {
        await step.sleep("wait", "1 second");
        return "done";
      }
    }
    const binding = new SqliteWorkflowBinding(db, "conc-term", "SlowishWorkflow", { maxConcurrentInstances: 1 });
    binding._setClass(SlowishWorkflow, {});

    await binding.create({ id: "running-one" });
    const queued = await binding.create({ id: "queued-one" });

    let s = await queued.status();
    expect(s.status).toBe("queued");

    await queued.terminate();
    s = await queued.status();
    expect(s.status).toBe("terminated");
  });
});

describe("instance retention", () => {
  test("completed instances are cleaned up after retention period", async () => {
    const binding = new SqliteWorkflowBinding(db, "retention-wf", "TestWorkflow", { maxRetentionMs: 50 });
    binding._setClass(TestWorkflow, { TEST: true });

    const instance = await binding.create({ params: { value: "temp" } });
    await new Promise((r) => setTimeout(r, 100));

    const s = await instance.status();
    expect(s.status).toBe("complete");

    // Wait for retention period to expire
    await new Promise((r) => setTimeout(r, 60));

    // Creating a new instance triggers cleanup
    await binding.create({ params: { value: "new" } });

    // Old instance should be cleaned up
    await expect(binding.get(instance.id)).rejects.toThrow("not found");
  });
});
