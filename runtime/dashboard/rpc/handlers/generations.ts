import type { HandlerContext, GenerationsData, GenerationInfo, OkResponse } from "../types";

export const handlers = {
  "generations.list"(_input: {}, ctx: HandlerContext): GenerationsData {
    if (!ctx.manager) throw new Error("Generation manager not available");
    return {
      generations: ctx.manager.list(),
      gracePeriodMs: ctx.manager.gracePeriodMs,
    };
  },

  async "generations.reload"(_input: {}, ctx: HandlerContext): Promise<{ ok: true; generation: GenerationInfo }> {
    if (!ctx.manager) throw new Error("Generation manager not available");
    const gen = await ctx.manager.reload();
    return { ok: true, generation: gen.getInfo() };
  },

  "generations.drain"(_input: {}, ctx: HandlerContext): { ok: true; stoppedGeneration: number } {
    if (!ctx.manager) throw new Error("Generation manager not available");
    const gens = ctx.manager.list().filter(g => g.state === "draining");
    if (gens.length === 0) throw new Error("No draining generations");
    const oldest = gens.reduce((a, b) => a.createdAt < b.createdAt ? a : b);
    ctx.manager.stop(oldest.id);
    return { ok: true, stoppedGeneration: oldest.id };
  },

  "generations.config"({ gracePeriodMs }: { gracePeriodMs: number }, ctx: HandlerContext): { ok: true; gracePeriodMs: number } {
    if (!ctx.manager) throw new Error("Generation manager not available");
    if (typeof gracePeriodMs !== "number" || gracePeriodMs < 0) throw new Error("Invalid gracePeriodMs");
    ctx.manager.setGracePeriod(gracePeriodMs);
    return { ok: true, gracePeriodMs: ctx.manager.gracePeriodMs };
  },
};
