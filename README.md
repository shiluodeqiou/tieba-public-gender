# 百度贴吧公开性别标记

一个可直接安装的 Tampermonkey 油猴脚本，在百度贴吧电脑网页版帖子昵称旁显示用户**公开填写的性别资料**。

当前版本 **1.0.3**：修复重新查询复用旧请求、冷却状态被缓存、切换帖子后旧任务继续排队的问题，并优先缓存常遇到的吧友。页面仅显示昵称旁的性别标记，开关和重新查询功能在油猴菜单中。已安装旧版时，点击安装链接更新，再刷新帖子。

[直接安装脚本](https://raw.githubusercontent.com/shiluodeqiou/tieba-public-gender/main/tieba-public-gender.user.js) · [GitHub 仓库](https://github.com/shiluodeqiou/tieba-public-gender) · [反馈问题](https://github.com/shiluodeqiou/tieba-public-gender/issues)

```text
示例昵称一  ♂ 男
示例昵称二  ♀ 女
示例昵称三  ? 未知
```

这不是性别识别模型。标记来自贴吧公开资料接口，不代表真实身份；脚本不根据昵称、头像、发言或其他个人信息推测性别。

## 功能与支持范围

- 适用网址：`https://tieba.baidu.com/p/帖子编号`，以及对应 HTTP 地址。
- 支持已检查的新版 Vue 页面和旧版电脑网页版主楼/回复楼层、楼中楼作者；动态添加的回复也会扫描。
- 使用页面明确提供的账号名或 `tb.*` 公开账号标识查询，并核对返回的账号；不把显示昵称当成账号名。
- 已识别的公开字段显示 `♂ 男` / `♀ 女`；未公开、账号信息缺失、接口失败或不支持的字段显示 `? 未知`。
- 将鼠标停在标记上，可查看来源说明或无法显示的原因。
- 相同账号的查询会合并；最多同时请求 2 次，新请求间隔至少 900 毫秒。遇到访问拒绝、限流、验证页或异常重定向，整条队列暂停 1 分钟，到期后自动恢复当前帖子的查询。
- 本地缓存最多 500 个账号，优先保留最近遇到的吧友。有效公开资料保存 24 小时，未公开/不支持的值保存 1 小时，一般网络错误保存 5 分钟。冷却、限流、取消等临时状态不保存为资料结果。
- 缓存在油猴本地存储中，刷新页面、重新打开帖子后仍有效；同一账号再次出现时优先读取缓存。读取不延长原有有效期，到期后在后续查询时重新获取，避免长期沿用已修改的资料。
- 油猴菜单明确显示标记功能“已开启/已关闭”和未知标记“显示/隐藏”；页面不添加浮窗。
- 油猴菜单可以开关标记、显示/隐藏未知、清空缓存并重新查询。重新查询会取消旧任务，旧响应不能覆盖新结果；已存在的请求间隔与冷却限制仍然有效。
- 开关设置会保存。关闭或切换帖子时移除旧标记，取消旧队列并尝试中止正在进行的请求；即使扩展取消失败，也会忽略旧响应。
- 从列表页通过站内跳转进入帖子时也会启动。非帖子页不显示标记，不查询资料。已完成的有效缓存可供其他帖子复用。

不覆盖手机/H5、贴吧 App、论坛列表页或所有未来改版。网站结构或接口改变后，可能需要更新脚本。

## 安装（不需要 Node.js）

1. 在浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)。如扩展提示需要允许用户脚本，请按提示开启浏览器的相应选项。
2. 点击上方“直接安装脚本”，在 Tampermonkey 安装页面确认安装。
3. 若浏览器只显示文本，打开 Tampermonkey 管理面板，选择“添加新脚本”，删除默认示例，将本项目的 [`tieba-public-gender.user.js`](./tieba-public-gender.user.js) 全部内容粘贴进去，保存。
4. 打开或刷新一个百度贴吧电脑网页版帖子，等待资料查询完成。
5. 点击 Tampermonkey 图标，在本脚本菜单中查看“标记功能：已开启（点击关闭）”，并按需调整设置。

“直接安装脚本”指向仓库 `main` 分支的 `.user.js` 原始文件。脚本包含同一仓库的更新地址，可通过 Tampermonkey 检查后续更新。

## 数据来源和权限

脚本只向以下贴吧 HTTPS 公开资料接口发送 GET 请求：

```text
https://tieba.baidu.com/home/get/panel?ie=utf-8&un=<编码后的账号名>
https://tieba.baidu.com/home/get/panel?ie=utf-8&id=<编码后的公开账号标识>
```

接收成功结果 `no: 0` 后，按查询类型检查 `data.name` 与请求账号名完全一致，或 `data.portrait` 与请求的公开账号标识一致。接口附在 `portrait` 后的 `?t=数字时间戳` 不属于账号标识，核对前会移除；不接受其他任意标识格式。核对成功后才读取 `data.sex`。本版本仅接受实际核实过的 `male` 和 `female` 字符串；数字 `1`/`2` 等未核实值不会被转换为性别。接口标示资料私密时也按未知处理。

使用的油猴权限：

| 权限 | 用途 |
| --- | --- |
| `GM_xmlhttpRequest`、`@connect tieba.baidu.com` | 请求贴吧公开资料 |
| `GM_getValue` / `GM_setValue` | 将精简结果保存在油猴本地存储 |
| `GM_registerMenuCommand` / `GM_unregisterMenuCommand` | 显示和更新标记开关、未知显示及缓存清理菜单 |

请求设置 `anonymous: true`，不发送 Cookie；不读取登录凭据、不调用 AI、不上传资料到第三方。账号名或公开账号标识会作为查询参数发送给贴吧。缓存只保留账号标识类型和值、标记、原因和到期时间，不保存接口返回的完整资料、头像、帖子内容或认证信息。没有额外的远程脚本依赖。

`anonymous` 的行为及请求权限参见 [Tampermonkey 官方请求文档](https://www.tampermonkey.net/documentation.php?locale=en&q=GM_xmlhttpRequest)。浏览器/扩展网络行为与匿名命令行访问可能不同，需要在实际安装环境中验收。

## 无法显示时

| 表现 | 检查方式 |
| --- | --- |
| 完全没有标记 | 确认脚本启用、当前为 `/p/数字` 的电脑帖子页，并允许 Tampermonkey 在该站点运行 |
| 菜单显示“标记功能：已关闭” | 点击此菜单开启标记；油猴扩展本身是否启用与脚本内部开关是两项设置 |
| 菜单显示已开启，仍没有标记 | 确认已更新至 1.0.3 并刷新帖子，等待内容加载；若持续没有标记，请反馈 |
| 开始显示 `…` | 正在排队/查询；账号多时需要等待，单次请求最长等待 10 秒 |
| 全是未知 | 将鼠标停在标记上看原因；可能是资料未公开、接口异常或页面缺少账号标识 |
| 资料已经修改但标记未变 | 使用“清空性别资料缓存并重新查询”菜单，无需刷新整页 |
| 显示未知且提示验证/访问拒绝 | 查询暂停一分钟后自动重试；如果仍受限会再次暂停，脚本不自动突破访问限制 |
| 昵称旁没有未知标记 | 查看油猴菜单是否显示“未知标记：隐藏”；点击此菜单即可恢复 |

## 项目结构

```text
tieba-public-gender/
├── tieba-public-gender.user.js  # 唯一需要安装的文件；也是测试加载的源文件
├── README.md                   # 安装、行为、维护和 GitHub 发布说明
├── LICENSE                     # MIT
├── package.json                # 开发检查配置，安装脚本无需 npm
├── package-lock.json           # 开发依赖锁定
├── .gitignore
├── .gitattributes
├── .github/workflows/test.yml  # 发布后的自动检查
├── docs/VALIDATION.md           # 验证记录与未覆盖事项
└── tests/
    ├── core.test.cjs            # 账号、字段、缓存与请求异常测试
    ├── dom.test.cjs             # 昵称标记、动态回复和菜单测试
    └── clock.cjs                # 冷却、请求间隔与缓存测试用虚拟时钟
```

## 开发检查

开发需要 Node.js `22.22.2+`（22.x）或 `24.15.0+`（24.x），或 26+。直接安装脚本不需要这些工具。

在项目目录运行：

```powershell
npm ci
npm run check
npm test
```

测试使用模拟资料与合成页面，不需要贴吧登录，不向贴吧发送请求。`jsdom` 仅供开发测试使用。没有构建步骤，修改 `.user.js` 后即可重新安装。

有关当前验证程度见 [`docs/VALIDATION.md`](./docs/VALIDATION.md)。自动化测试不能代替浏览器中实际启用油猴后的验收。

## GitHub 仓库与更新

项目地址为 [`shiluodeqiou/tieba-public-gender`](https://github.com/shiluodeqiou/tieba-public-gender)，脚本更新地址指向该仓库的 `main` 分支。首次手动安装了不含更新地址的版本时，需要重新安装本仓库的脚本一次，才能使用自动更新。

维护代码时，可以克隆仓库：

```powershell
git clone https://github.com/shiluodeqiou/tieba-public-gender.git
cd tieba-public-gender
npm ci
npm run check
npm test
```

修改脚本时提高 `@version`，同步 `package.json` 和锁文件版本，检查通过后再提交。GitHub Actions 会在推送和拉取请求时自动运行语法检查及测试。

若将项目发布到自己的 Fork，请将 `@homepageURL`、`@supportURL`、`@updateURL`、`@downloadURL` 和 README 中的链接改为自己仓库的实际地址。不要上传 `node_modules/`、登录凭据或本地缓存。

## 维护线索

- 公开接口 `/home/get/panel` 与 `male`/`female` 的历史用法可在 [该接口的公开调用示例](https://github.com/mokeyjay/mok_sexandage/blob/master/mok_sexandage.php) 中核对。本项目只参考接口形状，代码独立编写。
- 桌面帖子和楼中楼的历史页面结构可参考 [MediaCrawler 公开页面样本](https://github.com/NanmiCoder/MediaCrawler/tree/main/media_platform/tieba/test_data)。本项目测试页为合成数据，不包含该项目的真实用户页面或帖子正文。
- 这是贴吧网页内部接口，没有稳定兼容承诺。字段改变时应先核实含义，再修改解析器；不要因为字段名字相似而假定数值枚举一致。

## 许可证

[MIT](./LICENSE)。
