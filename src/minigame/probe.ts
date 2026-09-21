/**
 * WebGL2 功能探针 —— 小游戏适配里**唯一**需要真机验证的那一步。
 *
 * 为什么不能省：
 *   PixiJS 8 的着色器全是 `#version 300 es`（GLSL ES 3.00），渲染器只有 WebGL2 / WebGPU，
 *   **没有 WebGL1 路径**。而小游戏的 WebGL2 覆盖是分档的：
 *     - Android：8.0.24+（2022 年中）已支持，覆盖率 >85%
 *     - iOS：需要「高性能+」模式（客户端 8.0.45+、iOS 14+，实测建议 15.5+）；
 *       普通的「高性能」模式下官方原话是「使用 WebGL2 会存在较多问题，平台暂不保证所有能力完善」
 *   来源：微信开放社区《WebGL2.0渲染支持说明》。
 *
 * 更麻烦的是**失败形态**：在不兼容环境里，`getContext('webgl2')` 可能返回一个
 * 「看起来有效、实际是坏的」上下文，而不是 `null`。只判断返回值非空会漏掉这种情况，
 * 表现是花屏或黑屏，且一句提示都没有。所以这里做的是**功能性**探针：
 * 既查 WebGL2 独有的入口，也真编译一个 GLSL 300 es 程序。
 *
 * 探针用的是**离屏**画布，不是上屏那块 —— 在真机上直接对上屏画布取一次上下文，
 * 首次调用的属性会定死后续行为（Pixi 要 `stencil: true`，探针不一定请求），
 * 那会变成一个极难查的「渲染莫名缺模板缓冲」问题。
 */

import { createOffscreenCanvas } from './env';

export interface ProbeResult {
  ok: boolean;
  /** 失败原因，直接展示给玩家（要能指导他「升级微信」） */
  reason?: string;
  /** 诊断细节，写进日志 */
  detail: Record<string, unknown>;
}

const VERT = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
out vec4 outColor;
void main() {
  outColor = vec4(1.0, 0.5, 0.25, 1.0);
}`;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function safe<T>(fn: () => T): T | string {
  try {
    return fn() as T;
  } catch (e) {
    return `<抛错: ${errMsg(e)}>`;
  }
}

/** 真编译 + 链接一次，靠它确认驱动能跑 Pixi 那套 GLSL 300 es 着色器。 */
function shaderPipelineOk(gl: any): { ok: boolean; log?: string } {
  const make = (type: number, src: string) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      return { sh: null, log: String(gl.getShaderInfoLog(sh) || '').trim() };
    }
    return { sh, log: '' };
  };

  const vs = make(gl.VERTEX_SHADER, VERT);
  if (!vs.sh) return { ok: false, log: `顶点着色器编译失败：${vs.log}` };
  const fs = make(gl.FRAGMENT_SHADER, FRAG);
  if (!fs.sh) return { ok: false, log: `片元着色器编译失败：${fs.log}` };

  const prog = gl.createProgram();
  gl.attachShader(prog, vs.sh);
  gl.attachShader(prog, fs.sh);
  gl.linkProgram(prog);
  const linked = gl.getProgramParameter(prog, gl.LINK_STATUS);
  const log = linked ? '' : String(gl.getProgramInfoLog(prog) || '').trim();

  gl.deleteProgram(prog);
  gl.deleteShader(vs.sh);
  gl.deleteShader(fs.sh);

  return linked ? { ok: true } : { ok: false, log: `链接失败：${log}` };
}

export function probeWebGL2(): ProbeResult {
  const detail: Record<string, unknown> = {};

  let canvas: any;
  try {
    canvas = createOffscreenCanvas(1, 1);
  } catch (e) {
    return { ok: false, reason: `wx.createCanvas() 不可用：${errMsg(e)}`, detail };
  }

  let gl: any;
  try {
    gl = canvas.getContext('webgl2', { stencil: true, antialias: false });
  } catch (e) {
    return { ok: false, reason: `获取 webgl2 上下文抛错：${errMsg(e)}`, detail };
  }
  if (!gl) {
    return {
      ok: false,
      reason: "当前环境不支持 WebGL2（getContext('webgl2') 返回 null）。请升级微信到最新版",
      detail
    };
  }

  detail.version = safe(() => gl.getParameter(gl.VERSION));
  detail.glsl = safe(() => gl.getParameter(gl.SHADING_LANGUAGE_VERSION));
  detail.renderer = safe(() => {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
  });
  detail.maxTextureSize = safe(() => gl.getParameter(gl.MAX_TEXTURE_SIZE));

  // ① WebGL2 独有的入口。返回「假上下文」时这些通常缺失。
  if (typeof gl.createVertexArray !== 'function') {
    return { ok: false, reason: 'WebGL2 上下文缺少 createVertexArray：拿到的是不完整的上下文', detail };
  }
  if (typeof gl.texStorage2D !== 'function') {
    return { ok: false, reason: 'WebGL2 上下文缺少 texStorage2D：拿到的是不完整的上下文', detail };
  }

  // ② 真编译一次。函数存在 ≠ 驱动能跑 —— iOS「高性能」模式下出问题的正是着色器编译。
  const pipe = shaderPipelineOk(gl);
  detail.shaderPipeline = pipe.ok ? 'ok' : pipe.log;
  if (!pipe.ok) {
    return { ok: false, reason: `显卡驱动无法编译 WebGL2 着色器：${pipe.log ?? '未知原因'}`, detail };
  }

  // 探针的上下文用完就还回去，别占着一份 GL 资源
  safe(() => {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  });

  return { ok: true, detail };
}
