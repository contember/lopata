import { test, expect, beforeEach, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkflowEntrypointBase, SqliteWorkflowBinding } from "../bindings/workflow";
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
    const { SqliteWorkflowInstance } = await import("../bindings/workflow");
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
