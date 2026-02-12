import { test, expect, beforeEach, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkflowEntrypointBase, SqliteWorkflowBinding, SqliteWorkflowInstance } from "../bindings/workflow";
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
  override async run(_event: unknown, step: { do: <T>(name: string, cb: () => Promise<T>) => Promise<T>; waitForEvent: <T>(name: string, options: { type: string; timeout?: string }) => Promise<T> }): Promise<unknown> {
    const approval = await step.waitForEvent<{ approved: boolean }>("wait-approval", { type: "approval" });
    const result = await step.do("process", async () => {
      return { approved: approval.approved };
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
  override async run(_event: unknown, step: { waitForEvent: <T>(name: string, options: { type: string; timeout?: string }) => Promise<T> }): Promise<unknown> {
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
    expect(s.error).toBe("workflow failed");
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

    // Create a new binding instance with same db
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

    // Wait a bit for the workflow to reach waitForEvent
    await new Promise((r) => setTimeout(r, 50));

    let s = await instance.status();
    expect(s.status).toBe("waiting");

    // Send the event
    await instance.sendEvent({ type: "approval", payload: { approved: true } });

    // Wait for workflow to complete
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
    expect(s.error).toContain("timed out");
  });

  test("sendEvent before waitForEvent stores event in DB", async () => {
    class LateEventWorkflow extends WorkflowEntrypointBase {
      override async run(_event: unknown, step: { do: <T>(name: string, cb: () => Promise<T>) => Promise<T>; sleep: (name: string, duration: string) => Promise<void>; waitForEvent: <T>(name: string, options: { type: string }) => Promise<T> }): Promise<unknown> {
        // Sleep first so sendEvent happens before waitForEvent
        await step.sleep("delay", "1 second");
        const data = await step.waitForEvent<{ msg: string }>("get-data", { type: "data" });
        return data;
      }
    }
    const binding = new SqliteWorkflowBinding(db, "late-event", "LateEventWorkflow");
    binding._setClass(LateEventWorkflow, {});
    const instance = await binding.create();

    // Send event immediately (before workflow reaches waitForEvent)
    await instance.sendEvent({ type: "data", payload: { msg: "early" } });

    // Verify event is stored in DB
    const row = db.query("SELECT * FROM workflow_events WHERE instance_id = ?").get(instance.id);
    expect(row).not.toBeNull();

    // Wait for workflow to complete — it should pick up the stored event
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

    // Get instance via binding.get() and send event through that handle
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
});

describe("pause-aware step execution", () => {
  test("pause blocks step execution until resume", async () => {
    const binding = new SqliteWorkflowBinding(db, "slow-wf", "SlowWorkflow");
    binding._setClass(SlowWorkflow, {});
    const instance = await binding.create();

    // Pause immediately
    await instance.pause();
    let s = await instance.status();
    expect(s.status).toBe("paused");

    // Workflow should not complete while paused
    await new Promise((r) => setTimeout(r, 100));
    s = await instance.status();
    expect(s.status).toBe("paused");

    // Resume and let it complete
    await instance.resume();
    await new Promise((r) => setTimeout(r, 200));
    s = await instance.status();
    expect(s.status).toBe("complete");
    expect(s.output).toBe("done");
  });
});
