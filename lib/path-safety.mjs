/**
 * 路径安全：把"某个路径必须落在工作区内"这件事收口成一处实现。
 *
 * 这个插件里有四处需要这条判定（图像参考图、视频素材、音频转写输入、产物落盘）。
 * 前三个各自内联过一份，落盘那一处**漏了** —— 结果 `config.output.dir` 配成
 * `../../x` 或绝对路径时，产物会写到工作区外。抽成共享模块就是为了让"漏一处"
 * 这件事在结构上不容易再发生。
 *
 * 判定必须**分两层**，缺一层就有已知的绕过方式：
 *   ① **词法层**：`path.resolve` 之后做逐段比较，拒 `..`、绝对路径、盘符逃逸。
 *      这一层不碰文件系统，所以即使目标还不存在也能判定（产物目录通常还没建）。
 *   ② **真实路径层**：对**已存在的最深祖先**做 `fs.realpath` 再判一次。
 *      只做词法会被"工作区内的 junction / 符号链接"绕过 —— 链接自身字面上在
 *      cwd 内，目标却在外面（本插件实测复现过：`mklink /J ws\mnt C:\Windows`）。
 *
 * 为什么第二层只能查"最深已存在的祖先"：产物目录按设计还不存在，
 * `realpath` 对不存在的路径会直接 ENOENT。而"父目录的真实位置 + 尚未创建的
 * 相对尾巴"已经足以判断落点在哪 —— 尾巴不可能把路径挪到别处。
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { ARK_ERROR_CODES, ArkError } from './errors.mjs'

/**
 * 判定 target 是否落在 root 之内（含 root 自身）。
 *
 * ⚠️ 必须判断 `rel === '..'` 或以 `'..' + 分隔符` 开头，**不能**只写
 * `rel.startsWith('..')` —— 那会把工作区内合法的、名字以两个点开头的文件
 * （例如 `..foo.mp3`）误判成越界。这类误判很隐蔽：用户只看到"必须在工作区内"，
 * 而文件明明就在工作区里。
 *
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
export function isInside(root, target) {
  const rel = path.relative(root, target)
  if (rel === '') return true
  if (path.isAbsolute(rel)) return false
  if (rel === '..') return false
  return !rel.startsWith(`..${path.sep}`)
}

/**
 * 找出**已存在的最深祖先**，并返回它的 realpath。
 * 用于给"还没创建的目标路径"做真实路径判定。
 *
 * @param {string} target 绝对路径
 * @returns {Promise<{ existing: string, real: string } | undefined>}
 */
async function deepestExistingAncestor(target) {
  let cur = path.resolve(target)
  for (;;) {
    try {
      const real = await fs.realpath(cur)
      return { existing: cur, real }
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return undefined // 到根了还不存在
      cur = parent
    }
  }
}

/**
 * 断言 `target` 落在 `root` 之内，否则抛出 `INVALID_PARAMETER`。
 *
 * 两层判定都做；两层都必须过。任一层判为越界即拒绝 —— 不做"第二层通过就放行"
 * 的兜底，因为词法层被绕过时，真实路径层往往也已经指向外面了。
 *
 * @param {object} input
 * @param {string} input.root 工作区根目录
 * @param {string} input.target 待判定路径（可为尚不存在的目标）
 * @param {string} input.label 出错信息里用的名称，如"产物目录"
 * @returns {Promise<string>} target 的绝对路径（词法规范形式）
 * @throws {ArkError} code = INVALID_PARAMETER
 */
export async function assertInsideWorkspace({ root, target, label = '路径' }) {
  const absRoot = path.resolve(root)
  const absTarget = path.resolve(target)

  // ① 词法层：先拦明显的逃逸，且不碰文件系统（目标可能还不存在）
  if (!isInside(absRoot, absTarget)) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      `${label}必须位于工作区内：${absTarget}`
        + `（工作区 ${absRoot}）。请改用工作区内的相对路径，例如 ark-output。`,
    )
  }

  // ② 真实路径层：拦符号链接 / junction 逃逸
  //    对 root 与 target 各自取"已存在的最深祖先"的真实路径再比一次。
  const realRootProbe = await deepestExistingAncestor(absRoot)
  const realTargetProbe = await deepestExistingAncestor(absTarget)

  /**
   * **fail-closed**：真实路径层查不了就拒绝，不能"跳过这一层当它没发生"。
   *
   * 前提：`deepestExistingAncestor` 是**向上回溯**找"已存在的最深祖先"，不要求
   * 目标本身存在。所以：
   *   · root 探针几乎总能成功（回退到磁盘根总能命中已存在目录）；
   *   · target 在词法上位于 root 之内 ⇒ 它的祖先链覆盖 root 的祖先链，
   *     root 探到了 target 必然也探得到（两者最坏都会回退到同一个已存在祖先）。
   * 真正会失败的只有极端情形（盘符不存在、路径全链不可达）。那种情况下继续放行
   * 就等于"因为查不了所以不查"，而这是安全判定最不该有的默认值。
   *
   * 反过来的极端也要避免：**不能**因为 target 探针缺失就拒绝 ——
   * 产物目录按设计是"首次落盘才创建"，那条路必须照常放行。
   */
  if (!realRootProbe) {
    throw new ArkError(
      ARK_ERROR_CODES.FILE,
      `无法解析工作区的真实路径，为安全起见拒绝写入：${absRoot}。`
        + '请确认该路径可达（盘符存在、目录可访问）。',
    )
  }
  const targetReal = realTargetProbe ? realTargetProbe.real : realRootProbe.real
  if (!isInside(realRootProbe.real, targetReal)) {
    throw new ArkError(
      ARK_ERROR_CODES.INVALID_PARAMETER,
      `${label}的真实路径落在工作区外（符号链接 / junction 逃逸）：`
        + `${targetReal}（工作区真实路径 ${realRootProbe.real}）。`,
    )
  }

  return absTarget
}
