/** Re-export of the shared cross-thread RPC client. Kept as a stable import
 *  path for callers in `./thread-env.ts`; new code should import directly
 *  from `./rpc-shared`. */

export { RpcClient } from './rpc-shared'
