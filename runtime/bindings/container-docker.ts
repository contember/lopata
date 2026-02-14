import { $ } from "bun";

export interface DockerRunOptions {
  image: string;
  name: string;
  ports: Map<number, number>; // containerPort -> hostPort
  envVars?: Record<string, string>;
  entrypoint?: string[];
  enableInternet?: boolean;
}

export interface DockerContainerInfo {
  id: string;
  name: string;
  state: string; // "running", "exited", "created", etc.
  exitCode: number | null;
  ports: Record<string, string>;
}

// Track active containers for cleanup on process exit
const activeContainers = new Set<string>();
let cleanupRegistered = false;

function registerCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const cleanup = () => {
    for (const name of activeContainers) {
      try {
        Bun.spawnSync(["docker", "rm", "-f", name]);
      } catch {
        // best-effort cleanup
      }
    }
    activeContainers.clear();
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  process.on("exit", cleanup);
}

// Image build cache: tag -> { mtime }
const imageCache = new Map<string, { mtime: number }>();

export class DockerManager {
  /**
   * Build an image from a Dockerfile, with lazy mtime-based caching.
   * Skips rebuild if the Dockerfile hasn't changed since last build.
   */
  async buildImage(dockerfilePath: string, tag: string, context?: string): Promise<void> {
    const file = Bun.file(dockerfilePath);
    if (!(await file.exists())) {
      throw new Error(`Dockerfile not found: ${dockerfilePath}`);
    }
    const mtime = file.lastModified;
    const cached = imageCache.get(tag);
    if (cached && cached.mtime === mtime) {
      return; // Image already built and Dockerfile unchanged
    }

    const buildContext = context ?? (dockerfilePath.substring(0, dockerfilePath.lastIndexOf("/")) || ".");
    const result = await $`docker build -t ${tag} -f ${dockerfilePath} ${buildContext}`.quiet().nothrow();
    if (result.exitCode !== 0) {
      throw new Error(`Docker build failed (exit ${result.exitCode}): ${result.stderr.toString()}`);
    }
    imageCache.set(tag, { mtime });
  }

  /**
   * Run a container and return its container ID.
   */
  async run(options: DockerRunOptions): Promise<string> {
    registerCleanup();

    const args: string[] = ["docker", "run", "-d", "--name", options.name];

    // Port mappings
    for (const [containerPort, hostPort] of options.ports) {
      args.push("-p", `${hostPort}:${containerPort}`);
    }

    // Environment variables
    if (options.envVars) {
      for (const [key, value] of Object.entries(options.envVars)) {
        args.push("-e", `${key}=${value}`);
      }
    }

    // Network isolation
    if (options.enableInternet === false) {
      args.push("--network", "none");
    }

    // Entrypoint override
    if (options.entrypoint && options.entrypoint.length > 0) {
      args.push("--entrypoint", options.entrypoint[0]!);
      // Additional entrypoint args go after the image
    }

    args.push(options.image);

    // Entrypoint additional args
    if (options.entrypoint && options.entrypoint.length > 1) {
      args.push(...options.entrypoint.slice(1));
    }

    const result = await $`${args}`.quiet().nothrow();
    if (result.exitCode !== 0) {
      throw new Error(`Docker run failed (exit ${result.exitCode}): ${result.stderr.toString()}`);
    }

    const containerId = result.stdout.toString().trim();
    activeContainers.add(options.name);
    return containerId;
  }

  /**
   * Stop a running container gracefully.
   */
  async stop(name: string, timeoutSec?: number): Promise<void> {
    const args = ["docker", "stop"];
    if (timeoutSec !== undefined) {
      args.push("-t", String(timeoutSec));
    }
    args.push(name);
    await $`${args}`.quiet().nothrow();
  }

  /**
   * Kill a container immediately.
   */
  async kill(name: string): Promise<void> {
    await $`docker kill ${name}`.quiet().nothrow();
  }

  /**
   * Send a signal to a container.
   */
  async signal(name: string, sig: number): Promise<void> {
    await $`docker kill --signal ${sig} ${name}`.quiet().nothrow();
  }

  /**
   * Inspect a container and return its info, or null if not found.
   */
  async inspect(name: string): Promise<DockerContainerInfo | null> {
    const result = await $`docker inspect ${name} --format={{json .}}`.quiet().nothrow();
    if (result.exitCode !== 0) return null;

    try {
      const data = JSON.parse(result.stdout.toString());
      return {
        id: data.Id ?? "",
        name: (data.Name ?? "").replace(/^\//, ""),
        state: data.State?.Status ?? "unknown",
        exitCode: data.State?.ExitCode ?? null,
        ports: data.NetworkSettings?.Ports ?? {},
      };
    } catch {
      return null;
    }
  }

  /**
   * Remove a container (force).
   */
  async remove(name: string): Promise<void> {
    await $`docker rm -f ${name}`.quiet().nothrow();
    activeContainers.delete(name);
  }

  /**
   * Allocate a random available port by binding to port 0.
   */
  static async allocatePort(): Promise<number> {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response();
      },
    });
    const port = server.port;
    server.stop(true);
    if (!port || port <= 0) {
      throw new Error("Failed to allocate port");
    }
    return port;
  }
}
