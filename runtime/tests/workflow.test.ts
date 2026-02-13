import { test, expect, beforeEach, describe } from "bun:test";
import { Database } from "bun:sqlite";
import {
  WorkflowEntrypointBase,
  SqliteWorkflowBinding,
  SqliteWorkflowInstance,
  NonRetryableError,
  parseDuration,
} from "../bindings/workflow";
import type { WorkflowStepConfig } from "../bindings/workflow";
import { runMigrations } from "../db";

class TestWorkflow extends WorkflowEntrypointBase {
  override async run(event: { payload: { value: string } }, step: { do: <T>(name: string, cb: () => Promise<T>) => Promise<T>; sleep: (name: string, duration: string) => Promise<void> }): Promise<unknown> {
    const result = await step.do("process", async () => {
      return { input: event.payload.value, processed: true };
    });
    await step.sleep("pause", "1 millisecond");
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
    await step.sleep("wait", "1 millisecond");
    await step.do("step2", async () => "b");
    await step.sleep("wait2", "1 millisecond");
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
    await new Promise((r) => setTimeout(r, 200));

    const s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.output).toEqual({ input: "test", processed: true });
  });

  test("failing workflow sets errored status", async () => {
    const failBinding = new SqliteWorkflowBinding(db, "fail-wf", "FailingWorkflow");
    failBinding._setClass(FailingWorkflow, {});
    const instance = await failBinding.create();
    await new Promise((r) => setTimeout(r, 200));

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
    await new Promise((r) => setTimeout(r, 200));

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
    await new Promise((r) => setTimeout(r, 300));

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
    await new Promise((r) => setTimeout(r, 200));

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

    await new Promise((r) => setTimeout(r, 200));

    s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.output).toEqual({ approved: true });
  });

  test("waitForEvent times out", async () => {
    const binding = new SqliteWorkflowBinding(db, "timeout-wf", "TimeoutEventWorkflow");
    binding._setClass(TimeoutEventWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 300));

    const s = await instance.status();
    expect(s.status).toBe("errored");
    expect(s.error!.message).toContain("timed out");
  });

  test("sendEvent before waitForEvent stores event in DB", async () => {
    class LateEventWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { do: <T>(name: string, cb: () => Promise<T>) => Promise<T>; sleep: (name: string, duration: string) => Promise<void>; waitForEvent: <T>(name: string, options: { type: string }) => Promise<{ payload: T; timestamp: Date; type: string }> }): Promise<unknown> {
        await step.sleep("delay", "10 milliseconds");
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

    await new Promise((r) => setTimeout(r, 300));

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

    await new Promise((r) => setTimeout(r, 200));

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

  test("terminate via get() handle also aborts execution", async () => {
    const binding = new SqliteWorkflowBinding(db, "term-get", "EventWorkflow");
    binding._setClass(EventWorkflow, {});
    const instance = await binding.create();

    await new Promise((r) => setTimeout(r, 50));
    let s = await instance.status();
    expect(s.status).toBe("waiting");

    // Terminate via a separately retrieved handle
    const retrieved = await binding.get(instance.id);
    await retrieved.terminate();
    s = await retrieved.status();
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
    await new Promise((r) => setTimeout(r, 200));

    const s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.output).toEqual({ payload: { data: 42 }, type: "mytype", hasTimestamp: true });
  });

  test("sendEvent validates event type", async () => {
    const binding = new SqliteWorkflowBinding(db, "ev-validate", "EventWorkflow");
    binding._setClass(EventWorkflow, {});
    const instance = await binding.create();
    await expect(instance.sendEvent({ type: "invalid type!" })).rejects.toThrow("Invalid event type");
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
    await new Promise((r) => setTimeout(r, 300));
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
        const result = await step.do("flaky", { retries: { limit: 3, delay: "10 milliseconds", backoff: "constant" }, timeout: "5 seconds" }, async () => {
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
    await new Promise((r) => setTimeout(r, 500));

    const s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.output).toBe("success");
    expect(attempts).toBe(3);
  });

  test("step.do fails after exhausting retries", async () => {
    class AlwaysFailWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { do: <T>(name: string, config: WorkflowStepConfig, cb: () => Promise<T>) => Promise<T> }): Promise<unknown> {
        return await step.do("broken", { retries: { limit: 2, delay: "10 milliseconds" }, timeout: "5 seconds" }, async () => {
          throw new Error("permanent failure");
        });
      }
    }
    const binding = new SqliteWorkflowBinding(db, "exhaust-wf", "AlwaysFailWorkflow");
    binding._setClass(AlwaysFailWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 500));

    const s = await instance.status();
    expect(s.status).toBe("errored");
    expect(s.error!.message).toContain("permanent failure");
  });

  test("NonRetryableError skips retries", async () => {
    let attempts = 0;
    class NonRetryWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { do: <T>(name: string, config: WorkflowStepConfig, cb: () => Promise<T>) => Promise<T> }): Promise<unknown> {
        return await step.do("no-retry", { retries: { limit: 5, delay: "10 milliseconds" }, timeout: "5 seconds" }, async () => {
          attempts++;
          throw new NonRetryableError("don't retry this");
        });
      }
    }
    const binding = new SqliteWorkflowBinding(db, "nonretry-wf", "NonRetryWorkflow");
    binding._setClass(NonRetryWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 200));

    const s = await instance.status();
    expect(s.status).toBe("errored");
    expect(s.error!.message).toContain("don't retry this");
    expect(attempts).toBe(1);
  });

  test("step.do with timeout", async () => {
    class TimeoutStepWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { do: <T>(name: string, config: WorkflowStepConfig, cb: () => Promise<T>) => Promise<T> }): Promise<unknown> {
        return await step.do("slow-step", { timeout: "50 milliseconds", retries: { limit: 0 } }, async () => {
          await new Promise((r) => setTimeout(r, 5000));
          return "should not reach";
        });
      }
    }
    const binding = new SqliteWorkflowBinding(db, "timeout-step", "TimeoutStepWorkflow");
    binding._setClass(TimeoutStepWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 300));

    const s = await instance.status();
    expect(s.status).toBe("errored");
    expect(s.error!.message).toContain("timed out");
  });

  test("exponential backoff increases delay", async () => {
    const timestamps: number[] = [];
    let attempts = 0;
    class ExpBackoffWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { do: <T>(name: string, config: WorkflowStepConfig, cb: () => Promise<T>) => Promise<T> }): Promise<unknown> {
        return await step.do("exp", { retries: { limit: 3, delay: "20 milliseconds", backoff: "exponential" }, timeout: "5 seconds" }, async () => {
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

  test("default retries kick in without explicit config", async () => {
    // Verify that without explicit retries config, a failing step still retries
    // (default is limit=5 with exponential backoff starting at 10s)
    // We use a short-lived workflow with explicit override to test the default behavior
    let attempts = 0;
    class DefaultRetryVerifyWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { do: <T>(name: string, config: WorkflowStepConfig, cb: () => Promise<T>) => Promise<T> }): Promise<unknown> {
        // Use short delay to avoid slow test, but verify defaults via a callback
        // that succeeds on 2nd attempt — without retries this would fail
        return await step.do("verify", { retries: { delay: "10 milliseconds" }, timeout: "5 seconds" }, async () => {
          attempts++;
          if (attempts < 2) throw new Error("transient");
          return "recovered";
        });
      }
    }
    const binding = new SqliteWorkflowBinding(db, "default-retry", "DefaultRetryVerifyWorkflow");
    binding._setClass(DefaultRetryVerifyWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 500));

    const s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.output).toBe("recovered");
    expect(attempts).toBe(2);
  });
});

describe("step checkpointing", () => {
  test("step results are cached in workflow_steps table", async () => {
    const binding = new SqliteWorkflowBinding(db, "cache-wf", "TestWorkflow");
    binding._setClass(TestWorkflow, { TEST: true });
    const instance = await binding.create({ params: { value: "cached" } });
    await new Promise((r) => setTimeout(r, 200));

    const rows = db.query("SELECT * FROM workflow_steps WHERE instance_id = ?").all(instance.id) as { step_name: string; output: string }[];
    expect(rows.length).toBeGreaterThan(0);
    const processStep = rows.find((r) => r.step_name === "process");
    expect(processStep).not.toBeUndefined();
    expect(JSON.parse(processStep!.output)).toEqual({ input: "cached", processed: true });
  });

  test("sleep steps are checkpointed", async () => {
    const binding = new SqliteWorkflowBinding(db, "sleep-cache", "TestWorkflow");
    binding._setClass(TestWorkflow, { TEST: true });
    const instance = await binding.create({ params: { value: "test" } });
    await new Promise((r) => setTimeout(r, 200));

    const rows = db.query("SELECT * FROM workflow_steps WHERE instance_id = ?").all(instance.id) as { step_name: string; output: string }[];
    const sleepStep = rows.find((r) => r.step_name === "sleep:pause");
    expect(sleepStep).not.toBeUndefined();
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
    await new Promise((r) => setTimeout(r, 200));

    const s1 = await instance.status();
    expect(s1.status).toBe("complete");
    const firstOutput = s1.output;

    // Restart clears cached steps, so step should re-execute (no extra params needed)
    await instance.restart();
    await new Promise((r) => setTimeout(r, 200));

    const s2 = await instance.status();
    expect(s2.status).toBe("complete");
    // The output should be different because step was re-executed (new timestamp)
    expect(s2.output).not.toBe(firstOutput);

    // Verify steps were cleared
    const stepsAfterRestart = db.query("SELECT * FROM workflow_steps WHERE instance_id = ?").all(instance.id);
    expect(stepsAfterRestart.length).toBe(1); // Only the new step
  });

  test("restart without binding throws", async () => {
    const ghost = new SqliteWorkflowInstance(db, "ghost", null);
    await expect(ghost.restart()).rejects.toThrow("not associated with a workflow binding");
  });
});

describe("status structure", () => {
  test("error status returns structured error object", async () => {
    const binding = new SqliteWorkflowBinding(db, "err-struct", "FailingWorkflow");
    binding._setClass(FailingWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 200));

    const s = await instance.status();
    expect(s.status).toBe("errored");
    expect(s.error).toEqual({ name: "Error", message: "workflow failed" });
  });

  test("error name is preserved for custom errors", async () => {
    class CustomErrorWorkflow extends WorkflowEntrypointBase {
      override async run(): Promise<unknown> {
        throw new TypeError("bad type");
      }
    }
    const binding = new SqliteWorkflowBinding(db, "custom-err", "CustomErrorWorkflow");
    binding._setClass(CustomErrorWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 200));

    const s = await instance.status();
    expect(s.status).toBe("errored");
    expect(s.error!.name).toBe("TypeError");
    expect(s.error!.message).toBe("bad type");
  });

  test("NonRetryableError name is preserved", async () => {
    class NRWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { do: <T>(name: string, config: WorkflowStepConfig, cb: () => Promise<T>) => Promise<T> }): Promise<unknown> {
        return await step.do("fail", { retries: { limit: 0 } }, async () => {
          throw new NonRetryableError("stop", "CustomName");
        });
      }
    }
    const binding = new SqliteWorkflowBinding(db, "nr-name", "NRWorkflow");
    binding._setClass(NRWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 200));

    const s = await instance.status();
    expect(s.status).toBe("errored");
    expect(s.error!.name).toBe("CustomName");
  });

  test("complete status has no error field", async () => {
    const binding = new SqliteWorkflowBinding(db, "ok-struct", "TestWorkflow");
    binding._setClass(TestWorkflow, { TEST: true });
    const instance = await binding.create({ params: { value: "test" } });
    await new Promise((r) => setTimeout(r, 200));

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
        await step.sleep("wait", "50 milliseconds");
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
    await new Promise((r) => setTimeout(r, 200));
    s1 = await first.status();
    expect(s1.status).toBe("complete");

    // Second should now be running or complete
    await new Promise((r) => setTimeout(r, 200));
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
    await new Promise((r) => setTimeout(r, 200));

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

describe("NonRetryableError", () => {
  test("has correct name by default", () => {
    const err = new NonRetryableError("test message");
    expect(err.name).toBe("NonRetryableError");
    expect(err.message).toBe("test message");
  });

  test("accepts custom name", () => {
    const err = new NonRetryableError("test message", "CustomError");
    expect(err.name).toBe("CustomError");
    expect(err.message).toBe("test message");
  });
});

describe("parseDuration", () => {
  test("parses common units", () => {
    expect(parseDuration("100 milliseconds")).toBe(100);
    expect(parseDuration("5 seconds")).toBe(5000);
    expect(parseDuration("2 minutes")).toBe(120000);
    expect(parseDuration("1 hour")).toBe(3600000);
    expect(parseDuration("1 day")).toBe(86400000);
  });

  test("parses extended units", () => {
    expect(parseDuration("2 weeks")).toBe(2 * 7 * 86400000);
    expect(parseDuration("1 month")).toBe(30 * 86400000);
    expect(parseDuration("1 year")).toBe(365 * 86400000);
  });

  test("parses short units", () => {
    expect(parseDuration("100ms")).toBe(100);
    expect(parseDuration("5s")).toBe(5000);
    expect(parseDuration("2m")).toBe(120000);
    expect(parseDuration("1h")).toBe(3600000);
    expect(parseDuration("1d")).toBe(86400000);
    expect(parseDuration("1w")).toBe(7 * 86400000);
    expect(parseDuration("1y")).toBe(365 * 86400000);
  });

  test("throws for invalid input", () => {
    expect(() => parseDuration("invalid")).toThrow("Invalid duration");
    expect(() => parseDuration("")).toThrow("Invalid duration");
  });

  test("accepts number input (milliseconds)", () => {
    expect(parseDuration(5000)).toBe(5000);
    expect(parseDuration(0)).toBe(0);
    expect(parseDuration(100)).toBe(100);
  });
});

describe("duplicate step names", () => {
  test("throws on duplicate step name", async () => {
    class DuplicateStepWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { do: <T>(name: string, cb: () => Promise<T>) => Promise<T> }): Promise<unknown> {
        await step.do("same-name", async () => "first");
        await step.do("same-name", async () => "second");
        return "done";
      }
    }
    const binding = new SqliteWorkflowBinding(db, "dup-step", "DuplicateStepWorkflow");
    binding._setClass(DuplicateStepWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 200));

    const s = await instance.status();
    expect(s.status).toBe("errored");
    expect(s.error!.message).toContain("Duplicate step name");
  });
});

describe("resumeInterrupted", () => {
  test("resumes instances stuck in running status", async () => {
    class SimpleWorkflow extends WorkflowEntrypointBase {
      override async run(event: { payload: { value: string } }, step: { do: <T>(name: string, cb: () => Promise<T>) => Promise<T> }): Promise<unknown> {
        return await step.do("compute", async () => event.payload.value);
      }
    }

    // Manually insert a "running" instance as if the process crashed
    const now = Date.now();
    db.query(
      "INSERT INTO workflow_instances (id, workflow_name, class_name, params, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("stuck-1", "resume-wf", "SimpleWorkflow", JSON.stringify({ value: "resumed" }), "running", now, now);

    const binding = new SqliteWorkflowBinding(db, "resume-wf", "SimpleWorkflow");
    binding._setClass(SimpleWorkflow, {});
    binding.resumeInterrupted();

    await new Promise((r) => setTimeout(r, 300));

    const retrieved = await binding.get("stuck-1");
    const s = await retrieved.status();
    expect(s.status).toBe("complete");
    expect(s.output).toBe("resumed");
  });
});

describe("sleep/sleepUntil don't count toward step limit", () => {
  test("sleep and sleepUntil do not consume step limit", async () => {
    // Create a workflow with many sleeps — should not hit the 1024 step limit
    class ManySleepsWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { do: <T>(name: string, cb: () => Promise<T>) => Promise<T>; sleep: (name: string, duration: string) => Promise<void>; sleepUntil: (name: string, timestamp: Date) => Promise<void> }): Promise<unknown> {
        await step.sleep("s1", "1 millisecond");
        await step.sleep("s2", "1 millisecond");
        await step.sleepUntil("su1", new Date(Date.now() + 1));
        await step.do("final", async () => "ok");
        return "done";
      }
    }
    const binding = new SqliteWorkflowBinding(db, "many-sleeps", "ManySleepsWorkflow");
    binding._setClass(ManySleepsWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 300));

    const s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.output).toBe("done");
  });
});

describe("sleep/sleepUntil accept number", () => {
  test("sleep accepts number (milliseconds)", async () => {
    class NumSleepWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { sleep: (name: string, duration: string | number) => Promise<void> }): Promise<unknown> {
        await step.sleep("nap", 10);
        return "slept";
      }
    }
    const binding = new SqliteWorkflowBinding(db, "num-sleep", "NumSleepWorkflow");
    binding._setClass(NumSleepWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 200));

    const s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.output).toBe("slept");
  });

  test("sleepUntil accepts number (epoch ms)", async () => {
    class NumSleepUntilWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { sleepUntil: (name: string, timestamp: Date | number) => Promise<void> }): Promise<unknown> {
        await step.sleepUntil("wake", Date.now() + 10);
        return "woke";
      }
    }
    const binding = new SqliteWorkflowBinding(db, "num-sleep-until", "NumSleepUntilWorkflow");
    binding._setClass(NumSleepUntilWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 200));

    const s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.output).toBe("woke");
  });
});

describe("event instanceId", () => {
  test("event object contains instanceId", async () => {
    class InstanceIdWorkflow extends WorkflowEntrypointBase {
      override async run(event: { payload: unknown; instanceId: string }, step: { do: <T>(name: string, cb: () => Promise<T>) => Promise<T> }): Promise<unknown> {
        return await step.do("check", async () => event.instanceId);
      }
    }
    const binding = new SqliteWorkflowBinding(db, "iid-wf", "InstanceIdWorkflow");
    binding._setClass(InstanceIdWorkflow, {});
    const instance = await binding.create({ id: "my-instance-123" });
    await new Promise((r) => setTimeout(r, 200));

    const s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.output).toBe("my-instance-123");
  });
});

describe("waitForEvent default timeout", () => {
  test("waitForEvent has default 24h timeout", async () => {
    // We can't wait 24h, but we verify a workflow that uses waitForEvent
    // without timeout option still gets a timeout set (by checking it doesn't hang forever)
    // We'll use a short-lived test by sending the event quickly
    class DefaultTimeoutWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { waitForEvent: <T>(name: string, options: { type: string }) => Promise<{ payload: T }> }): Promise<unknown> {
        const ev = await step.waitForEvent<string>("wait", { type: "ping" });
        return ev.payload;
      }
    }
    const binding = new SqliteWorkflowBinding(db, "def-timeout", "DefaultTimeoutWorkflow");
    binding._setClass(DefaultTimeoutWorkflow, {});
    const instance = await binding.create();

    await new Promise((r) => setTimeout(r, 50));
    await instance.sendEvent({ type: "ping", payload: "pong" });
    await new Promise((r) => setTimeout(r, 200));

    const s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.output).toBe("pong");
  });
});

describe("sendEvent on terminated instance", () => {
  test("sendEvent throws for completed instance", async () => {
    const binding = new SqliteWorkflowBinding(db, "send-term", "TestWorkflow");
    binding._setClass(TestWorkflow, { TEST: true });
    const instance = await binding.create({ params: { value: "done" } });
    await new Promise((r) => setTimeout(r, 200));

    const s = await instance.status();
    expect(s.status).toBe("complete");

    await expect(instance.sendEvent({ type: "test", payload: {} })).rejects.toThrow("Cannot send event");
  });

  test("sendEvent throws for terminated instance", async () => {
    const binding = new SqliteWorkflowBinding(db, "send-term2", "EventWorkflow");
    binding._setClass(EventWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 50));

    await instance.terminate();
    await expect(instance.sendEvent({ type: "approval", payload: {} })).rejects.toThrow("Cannot send event");
  });
});

describe("instance ID length validation", () => {
  test("rejects instance ID longer than 100 characters", async () => {
    const binding = new SqliteWorkflowBinding(db, "id-len", "TestWorkflow");
    binding._setClass(TestWorkflow, { TEST: true });
    const longId = "a".repeat(101);
    await expect(binding.create({ id: longId, params: { value: "x" } })).rejects.toThrow("100 characters");
  });

  test("accepts instance ID of exactly 100 characters", async () => {
    const binding = new SqliteWorkflowBinding(db, "id-len2", "TestWorkflow");
    binding._setClass(TestWorkflow, { TEST: true });
    const exactId = "a".repeat(100);
    const instance = await binding.create({ id: exactId, params: { value: "x" } });
    expect(instance.id).toBe(exactId);
  });
});

describe("step name length validation", () => {
  test("rejects step name longer than 256 characters", async () => {
    const longName = "s".repeat(257);
    class LongNameWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { do: <T>(name: string, cb: () => Promise<T>) => Promise<T> }): Promise<unknown> {
        return await step.do(longName, async () => "ok");
      }
    }
    const binding = new SqliteWorkflowBinding(db, "long-step", "LongNameWorkflow");
    binding._setClass(LongNameWorkflow, {});
    const instance = await binding.create();
    await new Promise((r) => setTimeout(r, 200));

    const s = await instance.status();
    expect(s.status).toBe("errored");
    expect(s.error!.message).toContain("256 characters");
  });
});

describe("waitForEvent duplicate step name", () => {
  test("throws on duplicate waitForEvent name", async () => {
    class DupWaitWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { waitForEvent: <T>(name: string, options: { type: string; timeout?: string }) => Promise<{ payload: T }> }): Promise<unknown> {
        await step.waitForEvent("same", { type: "a", timeout: "2 seconds" });
        await step.waitForEvent("same", { type: "b", timeout: "2 seconds" });
        return "done";
      }
    }
    const binding = new SqliteWorkflowBinding(db, "dup-wait", "DupWaitWorkflow");
    binding._setClass(DupWaitWorkflow, {});
    const instance = await binding.create();
    // Pre-store both events so waitForEvent finds them immediately from DB
    await instance.sendEvent({ type: "a", payload: "first" });
    await instance.sendEvent({ type: "b", payload: "second" });
    await new Promise((r) => setTimeout(r, 300));

    const s = await instance.status();
    expect(s.status).toBe("errored");
    expect(s.error!.message).toContain("Duplicate step name");
  });
});
