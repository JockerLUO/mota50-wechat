/**
 * `wx.getSystemInfoSync()` 的**唯一入口**。
 *
 * 拆出来的理由：它被三处用（合成 navigator 的 UA、预订上屏画布的尺寸、
 * 宿主 `host.ts` 的窗口尺寸），而三次调用要读到**同一份**结果语义。
 * 原先它在 `env.ts` 里是个私有函数，拆目录后若各模块各调一次，
 * 「异常时返回 `{}`」这条兜底就会分散成三份、迟早漂移。
 */
import { wxApi, type Any } from './state';

/**
 * 读一次系统信息。
 *
 * `wx.getSystemInfoSync()` 在极早期调用或部分基础库上会抛，所以统一包一层 ——
 * navigator 合成、画布预订、宿主都要用它。
 */
export function readSystemInfo(): Any {
  try {
    return wxApi?.getSystemInfoSync?.() ?? {};
  } catch {
    return {};
  }
}
