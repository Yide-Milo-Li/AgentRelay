import { AgentRelayClientError } from "@/shared/errors/agent-relay-client-error";
import type { Lang } from "./locale";
import { dictionaries } from "./messages";

// Server routes answer in English; the Chinese UI maps the known messages and shows any other one as sent.
const serverErrorsZh: Record<string, string> = {
  "Sign in with ChatGPT first.": "请先使用 ChatGPT 登录。",
  "Sign in first.": "请先登录。",
  "This deployment's Cloudflare Access settings are missing or invalid.": "此部署的 Cloudflare Access 设置缺失或无效。",
  "Cloudflare Access keys are unavailable. Try again shortly.": "暂时无法获取 Cloudflare Access 密钥，请稍后重试。",
  "This deployment's database is full. Delete old handoffs in Settings › Storage, or move to a plan with more storage.": "此部署的数据库已满。请在“设置 › 存储”中删除旧交接，或改用存储空间更大的套餐。",
  "This deployment has used today's database allowance. It resets at 00:00 UTC.": "此部署今天的数据库额度已用完，将在 UTC 00:00 重置。",
  "Enable notifications in this browser first.": "请先在此浏览器中开启通知。",
  "Browser notifications are not configured on this Site.": "此站点尚未配置浏览器通知。",
  "Only the Chrome and Edge push services are supported.": "仅支持 Chrome 和 Edge 的推送服务。",
  "Choose a registered device.": "请选择一台已注册的设备。",
  "Notification options must be on or off.": "通知选项只能是开或关。",
  "A browser label must be 1–40 printable characters.": "浏览器标签须为 1–40 个可打印字符。",
  "Cross-site writes are not accepted.": "不接受跨站写入。",
  "The request is too large.": "请求过大。",
  "The request is not valid JSON.": "请求不是有效 JSON。",
  "The request must be a JSON object.": "请求必须为 JSON 对象。",
  "AgentRelay is temporarily unavailable. Try again shortly.": "服务暂时不可用，请稍后重试。",
  "Invalid handoff status.": "无效的交接状态。",
  "This handoff no longer exists or has expired.": "交接不存在或已过期。",
  "Project names are limited to 120 characters.": "项目名称不能超过 120 个字符。",
  "Project names must be 1–120 characters.": "项目名称须为 1–120 个字符。",
  "Project names need at least one letter or digit.": "项目名称至少需要包含一个字母或数字。",
  "This project doesn't exist.": "项目不存在。",
  "This project was just changed elsewhere. Refresh and try again.": "项目已在别处更新，请刷新后重试。",
  "You can have up to 500 projects. Merge or delete some first.": "最多可有 500 个项目，请先合并或删除部分项目。",
  "A project with that name already exists.": "已有同名项目。",
  "A project with that name already exists. Merge the two projects instead.": "已有同名项目，请改为合并这两个项目。",
  "Change at least the name, the colour or whether it is archived.": "请至少修改名称、颜色或归档状态。",
  "archived must be true or false.": "archived 须为 true 或 false。",
  "Choose the project to merge into.": "请选择要合并到的项目。",
  "A project can't be merged into itself.": "项目不能合并到自身。",
  "The project to merge into doesn't exist.": "要合并到的项目不存在。",
  "Expiry must be between 1 and 365 days.": "有效期须为 1–365 天。",
  "Acknowledge the permanent connection risk first.": "请先确认永久连接的风险。",
  "Connections changed since the preview. Refresh and review them again.": "连接列表已变化，尚未执行撤销。请刷新列表并重新核对。",
  "Preview a unique, non-empty list of active connection ids first.": "请先预览需要撤销的有效连接，连接列表不能为空或重复。",
  "connectionId is required.": "请先选择连接的签发者。",
  "Saving failed. Try again.": "保存失败，请重试。",
  "This request key was already used for a different prompt.": "该 requestKey 已用于不同的提示词，请换一个重试标识。",
  "The status changed elsewhere. Refresh and try again.": "状态已改变，请刷新后重试。",
  "Another device just updated this handoff. Refresh to continue.": "另一台设备刚刚更新了这条交接，请刷新。",
  "This handoff doesn't exist.": "交接不存在。",
  "Credential names must be 1–80 characters.": "凭据名称须为 1–80 个字符。",
  "This credential doesn't exist.": "凭据不存在。",
  "The latest version is required.": "必须提供最新的 version。",
  "Device names must be 1–80 characters with no control characters.": "设备名称须为 1–80 个字符，且不能包含控制字符。",
  "“Any device” is reserved and can't be used as a device name.": "设备名称不能使用保留名称“任意设备”。",
  "Device ids are 1–32 lowercase letters, digits or hyphens, and can't start or end with a hyphen.": "设备 ID 须为 1–32 位小写字母、数字或连字符，且不能以连字符开头或结尾。",
  "The ids any, all, none and self are reserved.": "设备 ID 不能使用保留词 any、all、none、self。",
  "“self” is reserved and can't be used as a device name.": "设备名称不能使用保留名称“self”。",
  "“self” only works for an Agent connection that is bound to a device. Use a device id instead.": "“self”只适用于已绑定设备的 Agent 连接，请改用设备 ID。",
  "That line colour isn't available.": "无效的线路颜色。",
  "connections must be unbind or revoke.": "connections 须为 unbind 或 revoke。",
  "That device id is already in use.": "该设备 ID 已被使用。",
  "A device with that name already exists.": "已有同名设备。",
  "That name matches another device's id. Choose a different name.": "设备名称与另一台设备的 ID 冲突，请换一个名称。",
  "That id matches another device's name. Choose a different id.": "设备 ID 与另一台设备的名称冲突，请换一个 ID。",
  "You can register up to 50 devices.": "最多可登记 50 台设备。",
  "That device already exists or was just created elsewhere. Refresh and try again.": "设备已存在，或刚被另一次操作创建，请刷新后重试。",
  "A device id can't be changed after it is created.": "设备 ID 创建后不能修改。",
  "Change at least the name or the colour.": "请至少修改名称或颜色。",
  "This device doesn't exist.": "设备不存在。",
  "This device was just changed elsewhere. Refresh and try again.": "设备已在别处更新，请刷新后重试。",
  "deviceId must be the id of a registered device.": "deviceId 须为已登记的设备 ID。",
  "You can keep up to 100 active connections. Revoke ones you no longer use first.": "最多可同时保留 100 个有效连接，请先撤销不再使用的连接。",
  "Change at least the name, the device or the lifetime.": "请至少修改名称、设备或有效期。",
  "Only the member who issued a connection can replace its secret. Create a new connection instead.": "只有签发该连接的成员才能更换它的密钥。请改为新建连接。",
  "reason must be bulk or offboarding.": "reason 须为 bulk 或 offboarding。",
  "A revoked or expired connection can't be changed.": "已失效的凭据不能修改。",
  "This connection was just changed elsewhere. Refresh and try again.": "连接已在别处更新，请刷新后重试。",
  "version must be a positive integer.": "version 须为正整数。",
  "before is not a valid history cursor.": "before 不是有效的历史游标。",
  "limit must be between 1 and 200.": "limit 须在 1–200 之间。",
  "tokenId is not valid.": "tokenId 无效。",
  "This connection is still active. Revoke it before removing it.": "凭据仍然有效，请先撤销再移除。",
  "scope must be inactive.": "scope 须为 inactive。",
  "The Agent Token is invalid, expired or revoked.": "Agent Token 无效、已过期或已撤销。",
  "A valid personal Agent Token is required.": "需要有效的个人 Agent Token。",
  "Invalid storage filters or cursor.": "存储筛选条件或分页位置无效，请重置筛选后重试。",
  "A current positive integer version is required.": "请提供当前有效的版本号。",
  "An upload key of 1–120 printable characters is required.": "需要 1–120 个可见字符的上传标识。",
  "This upload key was already used for a different image.": "该上传标识已用于另一张图片，请换一个。",
  "This upload is already attached to a handoff. Upload the image again with a new upload key.": "这张图片已附加到某条交接，请用新的上传标识重新上传。",
  "This upload expired. Upload the image again with a new upload key.": "这次上传已过期，请用新的上传标识重新上传。",
  "An attached image doesn't exist. Upload it again.": "所附图片不存在，请重新上传。",
  "An attached image already belongs to another handoff. Upload it again.": "所附图片已属于另一条交接，请重新上传。",
  "An attached image has not finished uploading.": "所附图片尚未上传完成。",
  "An attached image expired before it was sent. Upload it again.": "所附图片在发送前已过期，请重新上传。",
  "The attached images changed while sending. Try again.": "发送过程中所附图片发生了变化，请重试。",
  "attachmentIds must list at most 10 unique upload IDs.": "attachmentIds 最多包含 10 个互不相同的上传 ID。",
  "content must be at most 200000 characters.": "content 不能超过 200000 个字符。",
  "This image doesn't exist or has expired.": "图片不存在或已过期。",
  "This image is no longer available.": "图片已不可用。",
  "This handoff has no text to export; it contains images only.": "这条交接没有文字可导出，只包含图片。",
  "Only PNG, JPEG and WebP images are supported.": "仅支持 PNG、JPEG 和 WebP 图片。",
  "The file is empty.": "文件为空。",
  "Animated PNG (APNG) files are not supported; use a static image.": "不支持动态 PNG（APNG），请使用静态图片。",
  "Animated WebP files are not supported; use a static image.": "不支持动态 WebP，请使用静态图片。",
  "This JPEG uses a lossless or arithmetic-coded variant that browsers cannot show.": "这张 JPEG 使用了浏览器无法显示的无损或算术编码变体。",
  "Select between 1 and 50 handoffs.": "每次请选择 1 至 50 条交接。",
  "Handoff IDs must be unique, non-empty strings.": "交接 ID 不能为空或重复。",
};

export function describeError(error: unknown, lang: Lang): string {
  const t = dictionaries[lang];
  if (error instanceof AgentRelayClientError) {
    if (!error.serverMessage) return t[error.key];
    if (lang === "en") return error.serverMessage;
    const fieldLength = /^(\w+) must be 1–(\d+) characters\.$/.exec(error.serverMessage);
    if (fieldLength) return `${fieldLength[1]} 必须为 1–${fieldLength[2]} 个字符。`;
    const size = /^The image is ([\d,]+) bytes; the limit is ([\d,]+) bytes\.$/.exec(error.serverMessage);
    if (size) return `图片为 ${size[1]} 字节，超过 ${size[2]} 字节的上限。`;
    const streamed = /^The image is larger than the ([\d,]+)-byte limit\.$/.exec(error.serverMessage);
    if (streamed) return `图片超过 ${streamed[1]} 字节的上限。`;
    const edge = /^The image is (\d+)×(\d+) px; its longest edge is ([\d,]+) px and the limit is ([\d,]+) px\.$/.exec(error.serverMessage);
    if (edge) return `图片为 ${edge[1]}×${edge[2]} 像素，最长边 ${edge[3]} 像素，超过 ${edge[4]} 像素的上限。`;
    const pixels = /^The image is (\d+)×(\d+) px \(([\d,]+) pixels\); the limit is ([\d,]+) pixels\.$/.exec(error.serverMessage);
    if (pixels) return `图片为 ${pixels[1]}×${pixels[2]} 像素（共 ${pixels[3]} 像素），超过 ${pixels[4]} 像素的上限。`;
    const mismatch = /^The request says (\S+), but the file is (\S+)\. Send the real type or omit it\.$/.exec(error.serverMessage);
    if (mismatch) return `请求声明的类型是 ${mismatch[1]}，但文件实际是 ${mismatch[2]}。请发送真实类型或省略。`;
    const damaged = /^The (PNG|JPEG|WebP) /.exec(error.serverMessage);
    if (damaged) return `${damaged[1]} 文件已损坏或不完整，无法使用。`;
    return serverErrorsZh[error.serverMessage] ?? error.serverMessage;
  }
  return t.errFailed;
}
