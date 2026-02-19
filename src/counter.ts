import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject<Env> {
  async getCount(): Promise<number> {
    return (await this.ctx.storage.get<number>("count")) ?? 0;
  }

  override async alarm(): Promise<void> {
	console.log("Alarm triggered! Current count:", await this.getCount());
  }

  async increment(): Promise<number> {
    const count = (await this.getCount()) + 1;
    await this.ctx.storage.put("count", count);
    return count;
  }

  async decrement(): Promise<number> {
    const count = (await this.getCount()) - 1;
    await this.ctx.storage.put("count", count);
    return count;
  }

  async reset(): Promise<void> {
    await this.ctx.storage.delete("count");
  }
}
