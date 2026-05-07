# 飞书连接教程

管理员进入飞书开放平台，创建企业自建应用。应用创建后，管理员在应用详情页找到凭证与基础信息，并记录应用编号和应用密钥。该程序使用长连接模式，所以服务器只需要能访问公网，不需要公网域名。飞书文档说明，长连接模式由飞书开放平台和本地服务建立网络通道，后续事件会通过该通道发给本地服务。

管理员在应用能力中启用机器人能力。管理员随后进入事件与回调页面，把订阅方式设为使用长连接接收事件。飞书文档说明，长连接保存时，本地服务必须处于运行状态。因此，需要先在远端准备环境变量，再启动服务，然后回到飞书后台保存长连接设置。

```sh
ssh 机器
mkdir -p ~/.codex-im
cp ~/.codex-im/.env.example ~/.codex-im/.env
nano ~/.codex-im/.env
```

环境文件至少需要填入这些值。

```env
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
CODEX_IM_DEFAULT_CODEX_MODEL=gpt-5.5
CODEX_IM_DEFAULT_CODEX_EFFORT=xhigh
CODEX_IM_DEFAULT_CODEX_ACCESS_MODE=full-access
CODEX_IM_FEISHU_STREAMING_OUTPUT=true
```

管理员在飞书后台添加事件。该仓库文档列出三个事件：接收消息，消息被添加表情，消息被取消表情。后台里的事件名需要对应这些标识。

```text
im.message.receive_v1
im.message.reaction.created_v1
im.message.reaction.deleted_v1
```

管理员在飞书后台添加回调。该仓库文档要求启用卡片回传交互。飞书长连接文档也说明，卡片回传交互可以通过长连接客户端接收。

```text
card.action.trigger
```

管理员在权限管理中开通这些权限。该仓库文档列出的权限覆盖消息接收、发消息、图片和文件资源、表情、卡片读取和卡片更新。

```text
cardkit:card:read
cardkit:card:write
contact:user.base:readonly
im:message.p2p_msg:readonly
im:message:send_as_bot
im:message.reactions:write_only
im:resource
```

管理员创建版本并发布应用。企业自建应用通常还需要企业管理员审批。审批完成后，机器人才能在飞书客户端被使用。

服务启动命令如下。该命令需要在远端机器执行，因为程序会调用远端本机的程序服务。

```sh
ssh 机器
codex-im feishu-bot
```

服务启动后，飞书私聊机器人发送下面的命令来绑定项目目录。目录必须是远端机器上的绝对目录地址。

```text
/codex bind /absolute/project/dir
```

绑定项目后，用户从飞书发送给机器人的文件会被下载到当前绑定项目下的 `.codex-im/inbox/`，随后程序把保存后的相对路径交给 Codex 继续处理。

常用查看命令如下。第一个命令查看当前绑定信息。第二个命令新建线程。第三个命令查看可用模型。第四个命令查看帮助。

```text
/codex where
/codex new
/codex model
/codex help
```

## 参考资料

MrGeek-zrh. “codex-im.” *GitHub*, 2026, https://github.com/MrGeek-zrh/codex-im.

飞书开放平台. “步骤一：选择订阅方式（使用长连接接收回调）.” *飞书开放平台*, 17 Oct. 2025, https://feishu.apifox.cn/doc-7518469.

Larksuite. “node-sdk.” *GitHub*, 2026, https://github.com/larksuite/node-sdk.
