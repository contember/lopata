import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

type Params = {
  input: string;
};

export class MyWorkflow extends WorkflowEntrypoint<Env, Params> {
  override async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const result = await step.do("step 1: process input", async () => {
      return { processed: event.payload.input.toUpperCase() };
    });

    await step.sleep("wait a bit", "10 seconds");

    await step.do("step 2: finalize", async () => {
      return { final: result.processed, done: true };
    });
  }
}
