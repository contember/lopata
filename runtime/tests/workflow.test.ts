import { test, expect, beforeEach, describe } from "bun:test";
import { WorkflowEntrypointBase, InMemoryWorkflowBinding } from "../bindings/workflow";

class TestWorkflow extends WorkflowEntrypointBase {
  override async run(event: any, step: any): Promise<unknown> {
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

describe("InMemoryWorkflowBinding", () => {
  let binding: InMemoryWorkflowBinding;

  beforeEach(() => {
    binding = new InMemoryWorkflowBinding();
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

  test("create throws if class not wired", async () => {
    const binding2 = new InMemoryWorkflowBinding();
    await expect(binding2.create()).rejects.toThrow("not wired");
  });

  test("workflow executes steps", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    await binding.create({ params: { value: "test" } });
    // wait for async workflow to complete
    await new Promise((r) => setTimeout(r, 50));

    console.log = origLog;
    expect(logs.some((l) => l.includes("step: process"))).toBe(true);
    expect(logs.some((l) => l.includes("sleep: pause"))).toBe(true);
  });

  test("failing workflow logs error", async () => {
    const errors: string[] = [];
    const origError = console.error;
    const origLog = console.log;
    console.error = (...args: any[]) => errors.push(args.join(" "));
    console.log = () => {};

    const failBinding = new InMemoryWorkflowBinding();
    failBinding._setClass(FailingWorkflow, {});
    await failBinding.create();
    await new Promise((r) => setTimeout(r, 50));

    console.error = origError;
    console.log = origLog;
    expect(errors.some((e) => e.includes("failed"))).toBe(true);
  });
});
