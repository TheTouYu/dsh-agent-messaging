# dsh-agent-messaging — 模型互发消息

让任意两个 agent 会话跨会话互发消息(每会话可选开启),含历史会话自动恢复。

## 安装 / 注入

```bash
# 构建
cd /home/h/app/dsh-agent-messaging && npm pack   # 或 dev_build_plugin
# 注入(runtime,免重启)
dev_inject_plugin dir=/home/h/app/dsh-agent-messaging
# 或持久装配
dev_install_package dir=/home/h/app/dsh-agent-messaging
```

## 开关(每会话)

会话标题栏的「未接收/接收中」按钮,默认关闭;关闭时收到的消息进入待接收队列,输入框上方出现「有一条消息待接收」横幅,点「接收」即投递并自动开启开关。也可用命令 `/agent-messaging-toggle`、`/agent-messaging-accept`。

## 插入(打断)

子代理会话的输入框只能排队(架构限制,无 steer 快捷键);输入框旁新增「插入」按钮,或命令 `/agent-messaging-insert <文本>`,将消息立即插入(运行中在下一 step 消费,空闲则开新回合)。

## 工具用法

```
agent_list                                   # live 会话 + 离线可恢复会话:标题/时间/工作区/父子关系
agent_send id=<目标id|唯一前缀> text=<消息> purpose=<目的简述>
                                             # 目标开启时直接投递唤醒;未开启则入队(横幅提示);
                                             # 离线历史会话自动 resume 后投递;前缀不唯一会提示歧义
```

对方处理完后,发送方自动收到「完成汇报」(对方做了什么 + 上下文规模),不唤醒,自行决定何时处理。
